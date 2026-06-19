import makeWASocket, { 
    DisconnectReason,
    fetchLatestWaWebVersion,
    BufferJSON,
    initAuthCreds,
    proto
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple zero-dependency environment loader targeting root and local directory
const envFiles = [
    path.join(__dirname, '.env'),
    path.join(__dirname, '../.env')
];
for (const envPath of envFiles) {
    if (fs.existsSync(envPath)) {
        const envData = fs.readFileSync(envPath, 'utf8');
        envData.split('\n').forEach(line => {
            const parts = line.split('=');
            if (parts.length >= 2) {
                const key = parts[0].trim();
                const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
                if (key && !process.env[key]) {
                    process.env[key] = val;
                }
            }
        });
    }
}

// Supabase environment variables
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

// Express setup
const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend clients (Cloudflare Pages or localhost)
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Configuration Persistence Helpers (Supabase db-backed)
async function loadUserConfig(userId) {
    try {
        const { data, error } = await supabaseAdmin
            .from('user_configs')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
        
        if (error) throw error;
        
        if (!data) {
            const defaultConfig = {
                user_id: userId,
                gemini_api_key: '',
                gemini_model: 'gemini-2.5-flash',
                ai_contacts: []
            };
            await supabaseAdmin.from('user_configs').insert(defaultConfig);
            return {
                geminiApiKey: '',
                geminiModel: 'gemini-2.5-flash',
                aiContacts: []
            };
        }
        
        return {
            geminiApiKey: data.gemini_api_key || '',
            geminiModel: data.gemini_model || 'gemini-2.5-flash',
            aiContacts: data.ai_contacts || []
        };
    } catch (err) {
        console.error('Error loading config for user', userId, err);
        return { geminiApiKey: '', geminiModel: 'gemini-2.5-flash', aiContacts: [] };
    }
}

// Custom Supabase Database Auth State Provider for Baileys
async function useSupabaseAuthState(userId) {
    let { data, error } = await supabaseAdmin
        .from('whatsapp_sessions')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

    if (error) {
        console.error('Failed to load WhatsApp credentials from DB', error);
    }

    let creds;
    let keys = {};

    if (!data) {
        creds = initAuthCreds();
        await supabaseAdmin
            .from('whatsapp_sessions')
            .insert({
                user_id: userId,
                creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
                keys: JSON.parse(JSON.stringify(keys, BufferJSON.replacer))
            });
    } else {
        creds = JSON.parse(JSON.stringify(data.creds), BufferJSON.reviver);
        keys = JSON.parse(JSON.stringify(data.keys || {}), BufferJSON.reviver);
    }

    const saveCreds = async () => {
        await supabaseAdmin
            .from('whatsapp_sessions')
            .update({
                creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer))
            })
            .eq('user_id', userId);
    };

    return {
        state: {
            creds,
            keys: {
                get: (type, ids) => {
                    const result = {};
                    for (const id of ids) {
                        const key = `${type}:${id}`;
                        let value = keys[key];
                        if (value) {
                            if (type === 'app-state-sync-key') {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            result[id] = value;
                        }
                    }
                    return result;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const key = `${type}:${id}`;
                            const value = data[type][id];
                            if (value) {
                                keys[key] = value;
                            } else {
                                delete keys[key];
                            }
                        }
                    }
                    await supabaseAdmin
                        .from('whatsapp_sessions')
                        .update({
                            keys: JSON.parse(JSON.stringify(keys, BufferJSON.replacer))
                        })
                        .eq('user_id', userId);
                }
            }
        },
        saveCreds
    };
}

// Active User Sessions Pool
const activeSessions = new Map();

function getOrCreateSession(userId) {
    if (!activeSessions.has(userId)) {
        activeSessions.set(userId, {
            sock: null,
            status: 'disconnected',
            qrCode: '',
            logs: [],
            messages: [],
            contactPhoneMap: {},
            clients: new Set()
        });
    }
    return activeSessions.get(userId);
}

// Helper to log user session logs and update clients
function addSessionLog(userId, message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    const session = getOrCreateSession(userId);
    session.logs.push(logEntry);
    if (session.logs.length > 100) {
        session.logs.shift();
    }
    console.log(`[User ${userId}] ${logEntry}`);
    broadcastToUser(userId, { logs: session.logs, status: session.status, qrCode: session.qrCode });
}

function broadcastToUser(userId, data) {
    const session = activeSessions.get(userId);
    if (session && session.clients.size > 0) {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        session.clients.forEach(client => client.write(payload));
    }
}

// Express Token Authentication Middleware
async function requireAuthAPI(req, res, next) {
    const authHeader = req.headers.authorization;
    const token = req.cookies['sb-access-token'] || req.query.token || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null);
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
        if (error || !user) {
            return res.status(401).json({ success: false, error: 'Session expired' });
        }
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Session expired' });
    }
}

// Helper for direct lookup in public.bot_knowledge (exact or single-word matches)
function findDirectMatch(messageText, rows) {
    if (!rows || rows.length === 0) return null;
    const cleanMsg = messageText.toLowerCase().trim();
    
    // 1. First look for exact match
    for (const row of rows) {
        const cleanTrigger = row.trigger_pattern.toLowerCase().trim();
        if (cleanMsg === cleanTrigger) {
            return row.response_text;
        }
    }
    
    // 2. Look for word-based match (if trigger is a single word in the message)
    const words = cleanMsg.split(/\s+/);
    for (const row of rows) {
        const cleanTrigger = row.trigger_pattern.toLowerCase().trim();
        if (!cleanTrigger.includes(' ')) {
            if (words.includes(cleanTrigger)) {
                return row.response_text;
            }
        }
    }
    return null;
}

// Gemini API Query Helper
async function queryGemini(apiKey, modelName, messageText, talkingStyle, senderContext, contactContext, chatHistoryContext, knowledgeContext) {
    const model = modelName || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    let instructions = [];
    instructions.push("INSTRUCTIONS:");
    instructions.push("1. You are replying to a WhatsApp message on behalf of a real person.");
    instructions.push("2. Reply exactly like a human would: casual, natural, short. Never sound robotic, preachy, or like an AI assistant.");
    instructions.push("3. Absolutely do NOT output any thinking process, reasoning, explanation, context analysis, notes, or lists. Only output the final text message itself.");

    if (senderContext && senderContext.trim()) {
        instructions.push(`\nSENDER INFO (Your personality/style):\n${senderContext.trim()}`);
    }

    if (contactContext && contactContext.trim()) {
        instructions.push(`\nRECIPIENT INFO:\n${contactContext.trim()}`);
    }

    if (talkingStyle && talkingStyle.trim()) {
        instructions.push(`\nREQUIRED TALKING STYLE / TONE:\n${talkingStyle.trim()}`);
    }

    if (knowledgeContext && knowledgeContext.trim()) {
        instructions.push(`\nBUSINESS KNOWLEDGE BASE (Use these facts first to answer customer queries. Do not make up facts contrary to these details):\n${knowledgeContext.trim()}`);
    }

    const systemPrompt = instructions.join('\n');
    let promptText = `${systemPrompt}\n\n`;
    if (chatHistoryContext && chatHistoryContext.trim()) {
        promptText += `${chatHistoryContext.trim()}\n\n`;
    }
    promptText += `MESSAGE TO REPLY TO:\n"${messageText}"\n\nYOUR REPLY:`;

    const requestBody = {
        contents: [{
            parts: [{ text: promptText }]
        }],
        generationConfig: {
            maxOutputTokens: 60,
            temperature: 0.8
        }
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
        throw new Error('Empty response from Gemini model');
    }
    return cleanModelResponse(rawText.trim());
}

// Strip chain-of-thought / reasoning that Gemma models dump into output
function cleanModelResponse(text) {
    const replyMarker = text.lastIndexOf('YOUR REPLY:');
    if (replyMarker !== -1) {
        text = text.substring(replyMarker + 'YOUR REPLY:'.length).trim();
    }

    text = text.replace(/\*\*([^*]+)\*\*/g, '$1');

    const lines = text.split('\n').map(line => {
        let t = line.trim();
        t = t.replace(/^[\*\-•]\s+/, '');
        t = t.replace(/^\d+[\.\)]\s+/, '');
        return t;
    }).filter(t => t.length > 0);

    const isMetaLine = (line) => {
        const l = line.toLowerCase();
        if (/^(role|personality|style|tone|constraint|input|output|option|context|message|thinking|reasoning|analysis|note|sender|recipient|required|the input|the output|the message|the required|the user|the persona|common|typical|appropriate|emoji|wave|smile|since|let'?s go|keeping it|a simple|does it)[\s:\.]/i.test(line)) return true;
        if (l.includes('no thinking process') || l.includes('no explanation') || l.includes('purely emoji') || l.includes('no markdown') || l.includes('no robotic') || l.includes('no bullet') || l.includes('no text') || l.includes('constraint') || l.includes('implies') || l.includes('represents') || l.includes('response for') || l.includes('output format') || l.includes('most natural') || l.includes('follow') || l.includes('does it') || l.includes('only output') || l.includes('final text')) return true;
        if (/^[A-Z][a-z]+ (emoji|response|option|message|text):/i.test(line)) return true;
        if (/^\(.+\)$/.test(line)) return true;
        if (/"[^"]{1,30}"/.test(line) && l.includes('for')) return true;
        if (/\?\s*(yes|no|correct|true)\.?$/i.test(line)) return true;
        return false;
    };

    const cleaned = lines.filter(line => !isMetaLine(line));

    if (cleaned.length > 0) {
        return cleaned[cleaned.length - 1].trim();
    }
    if (lines.length > 0) {
        return lines[lines.length - 1].trim();
    }
    return text.trim();
}

// Save chat log to Supabase
async function saveChatLog(userId, chatJid, senderJid, senderName, messageText, isFromMe) {
    try {
        if (!supabaseUrl || !supabaseServiceRoleKey) return null;
        const msgObj = {
            user_id: userId,
            chat_jid: chatJid,
            sender_jid: senderJid,
            sender_name: senderName || 'Unknown',
            message_text: messageText,
            is_from_me: isFromMe,
            created_at: new Date().toISOString()
        };

        const { data, error } = await supabaseAdmin.from('chat_logs').insert(msgObj).select();
        if (error) throw error;

        const savedMessage = (data && data[0]) ? data[0] : msgObj;

        // Broadcast via SSE
        broadcastToUser(userId, { type: 'chat_message', message: savedMessage });
        
        return savedMessage;
    } catch (err) {
        console.error('[Database Error] Error saving chat log:', err.message);
        return null;
    }
}

// Fetch chat history from Supabase for context
async function getChatHistoryPrompt(userId, chatJid, limit = 10) {
    try {
        if (!supabaseUrl || !supabaseServiceRoleKey) return '';
        const { data, error } = await supabaseAdmin
            .from('chat_logs')
            .select('sender_name, message_text, is_from_me')
            .eq('user_id', userId)
            .eq('chat_jid', chatJid)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        if (!data || data.length === 0) return '';

        const reversed = [...data].reverse();
        return reversed.map(log => {
            const sender = log.is_from_me ? 'Me' : (log.sender_name || 'Contact');
            return `${sender}: ${log.message_text}`;
        }).join('\n');
    } catch (err) {
        console.error('Error fetching chat history context:', err);
        return '';
    }
}

// Get message summaries for logs
function getMessageSummary(message) {
    if (!message) return '';
    const key = Object.keys(message)[0];
    if (key === 'conversation') {
        return message.conversation;
    }
    if (key === 'extendedTextMessage') {
        return message.extendedTextMessage.text;
    }
    if (key === 'imageMessage') {
        return `[📷 Image: ${message.imageMessage.caption || 'No caption'}]`;
    }
    if (key === 'videoMessage') {
        return `[📹 Video: ${message.videoMessage.caption || 'No caption'}]`;
    }
    if (key === 'documentMessage') {
        return `[📄 Document: ${message.documentMessage.title || 'Attachment'}]`;
    }
    if (key === 'audioMessage') {
        return `[🎵 Audio: Voice Note]`;
    }
    if (key === 'locationMessage') {
        const lat = message.locationMessage.degreesLatitude?.toFixed(4) || 0;
        const lng = message.locationMessage.degreesLongitude?.toFixed(4) || 0;
        return `[📍 Location: Lat ${lat}, Lng ${lng}]`;
    }
    if (message.contactMessage) {
        return `[👤 Contact: ${message.contactMessage.displayName}]`;
    }
    if (message.contactsArrayMessage) {
        return `[👤 Contacts: ${message.contactsArrayMessage.contacts.length} cards]`;
    }
    if (message.reactionMessage) {
        return `[❤️ Reaction: ${message.reactionMessage.text}]`;
    }
    if (message.pollCreationMessage) {
        return `[📊 Poll: "${message.pollCreationMessage.name}"]`;
    }
    return `[Media/System message: ${key}]`;
}

// Start user-specific Baileys Connection
async function connectToWhatsApp(userId) {
    const session = getOrCreateSession(userId);
    
    if (session.sock) {
        addSessionLog(userId, 'Bot already connecting or connected. Ignoring request.');
        return;
    }

    session.status = 'connecting';
    addSessionLog(userId, 'Initializing WhatsApp connection...');

    try {
        const { state, saveCreds } = await useSupabaseAuthState(userId);
        
        let version = [2, 3000, 1015901307];
        try {
            const fetched = await fetchLatestWaWebVersion();
            version = fetched.version;
            addSessionLog(userId, `Fetched latest WhatsApp Web version: ${version.join('.')}`);
        } catch (err) {
            addSessionLog(userId, `Failed to fetch WA version, using fallback: ${err.message}`);
        }

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        session.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        const processContacts = (contacts) => {
            for (const contact of contacts) {
                if (contact.id && contact.lid) {
                    const phone = contact.id.split('@')[0];
                    const lid = contact.lid.split('@')[0];
                    if (phone && lid) {
                        session.contactPhoneMap[lid] = phone;
                        session.contactPhoneMap[phone] = phone;
                    }
                }
                if (contact.id && contact.id.endsWith('@lid') && contact.notify) {
                    const lid = contact.id.split('@')[0];
                    if (!session.contactPhoneMap[lid]) {
                        session.contactPhoneMap[lid] = lid;
                    }
                }
            }
        };

        sock.ev.on('contacts.upsert', processContacts);
        sock.ev.on('contacts.update', processContacts);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                try {
                    session.qrCode = await QRCode.toDataURL(qr);
                    session.status = 'connecting';
                    broadcastToUser(userId, { status: 'connecting', qrCode: session.qrCode });
                    addSessionLog(userId, 'New QR Code generated. Scan from the dashboard.');
                } catch (err) {
                    addSessionLog(userId, `Error generating QR Code: ${err.message}`);
                }
            }

            if (connection === 'close') {
                const errMessage = lastDisconnect?.error?.message || '';
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                const isConflict = errMessage.toLowerCase().includes('conflict') || statusCode === DisconnectReason.connectionReplaced;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const shouldReconnect = !isLoggedOut && !isConflict;
                
                addSessionLog(userId, `Connection closed due to: ${errMessage || lastDisconnect?.error || 'Unknown Error'}. Reconnecting in 5s: ${shouldReconnect}`);
                
                session.sock = null;
                session.status = isConflict ? 'conflict' : 'disconnected';
                session.qrCode = '';
                broadcastToUser(userId, { status: session.status, qrCode: '' });
                
                if (shouldReconnect) {
                    session.reconnectTimeout = setTimeout(() => {
                        session.reconnectTimeout = null;
                        connectToWhatsApp(userId);
                    }, 5000);
                } else if (isConflict) {
                    addSessionLog(userId, 'Auto-reconnect disabled because the number is connected to another device.');
                }
            } else if (connection === 'open') {
                session.status = 'connected';
                session.qrCode = '';
                broadcastToUser(userId, { status: 'connected', qrCode: '' });
                addSessionLog(userId, 'WhatsApp connection is open and active!');
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            
            if (!msg.key.fromMe && m.type === 'notify' && msg.message) {
                const messageContent = getMessageSummary(msg.message);

                if (messageContent) {
                    const isGroup = msg.key.remoteJid.endsWith('@g.us');
                    const senderJid = isGroup ? msg.key.participant : msg.key.remoteJid;
                    const rawId = senderJid ? senderJid.split('@')[0] : 'Unknown';
                    
                    const resolvedPhone = session.contactPhoneMap[rawId] || rawId;
                    const senderNumber = resolvedPhone;
                    
                    const pushName = msg.pushName || '';
                    const displayName = pushName ? `${pushName} (${resolvedPhone})` : resolvedPhone;
                    const source = isGroup ? `Group (${msg.key.remoteJid.split('@')[0]}) from ${displayName}` : displayName;

                    console.log(`[WhatsApp Message - User ${userId}] ${source}: ${messageContent}`);
                    
                    // Save incoming message to Supabase
                    const fromName = msg.pushName || 'WhatsApp User';
                    await saveChatLog(userId, msg.key.remoteJid, senderJid, fromName, messageContent, false);
                    
                    if (typeof messageContent === 'string' && messageContent.toLowerCase() === 'ping') {
                        addSessionLog(userId, `Auto-replying 'pong!' to ${senderNumber}`);
                        try {
                            await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                        } catch (e) {
                            console.error('Error sending presence update:', e);
                        }
                        await new Promise(r => setTimeout(r, 1000));
                        await sock.sendMessage(msg.key.remoteJid, { text: 'pong!' });
                        
                        const botJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : 'bot@s.whatsapp.net';
                        await saveChatLog(userId, msg.key.remoteJid, botJid, 'System Bot', 'pong!', true);
                        
                        try {
                            await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                        } catch (e) {}
                        return;
                    }

                    // Dynamically fetch config from Supabase to guarantee fresh API key, model and target list configurations
                    const freshConfig = await loadUserConfig(userId);

                    // Match contact auto-reply configurations
                    const aiContact = freshConfig.aiContacts.find(c => {
                        const configJid = c.number.trim().toLowerCase();
                        const remoteJid = (msg.key.remoteJid || '').toLowerCase();
                        const participantJid = (msg.key.participant || '').toLowerCase();
                        
                        if (configJid === remoteJid || (isGroup && configJid === participantJid)) {
                            return true;
                        }
                        
                        const cleanConfig = configJid.replace(/\D/g, '');
                        if (cleanConfig && cleanConfig.length >= 8) {
                            const cleanRemote = remoteJid.replace(/\D/g, '');
                            const cleanParticipant = participantJid.replace(/\D/g, '');
                            return cleanRemote.endsWith(cleanConfig) || (isGroup && cleanParticipant.endsWith(cleanConfig));
                        }
                        return false;
                    });

                    if (aiContact) {
                        if (!freshConfig.geminiApiKey) {
                            addSessionLog(userId, `[AI Warning] Message received from ${displayName}, but Gemini API Key is not configured.`);
                        } else {
                            try {
                                const historyPrompt = await getChatHistoryPrompt(userId, msg.key.remoteJid, 10);
                                
                                // Fetch knowledge base from Supabase
                                let knowledgeRows = [];
                                try {
                                    const { data, error } = await supabaseAdmin
                                        .from('bot_knowledge')
                                        .select('trigger_pattern, response_text')
                                        .eq('user_id', userId);
                                    if (!error && data) {
                                        knowledgeRows = data;
                                    }
                                } catch (err) {
                                    console.error('Failed to load bot knowledge:', err);
                                }

                                // Check for a direct lookup match
                                const directMatch = findDirectMatch(messageContent, knowledgeRows);
                                let replyText = '';

                                if (directMatch) {
                                    addSessionLog(userId, `[Direct Match] Direct response triggered for "${messageContent}"`);
                                    replyText = directMatch;
                                } else {
                                    addSessionLog(userId, `[AI Trigger] Querying Gemini for ${displayName}...`);
                                    // Build knowledge context string
                                    let knowledgeContext = '';
                                    if (knowledgeRows.length > 0) {
                                        knowledgeContext = knowledgeRows.map(row => 
                                            `Question/Topic: "${row.trigger_pattern}"\nAnswer: "${row.response_text}"`
                                        ).join('\n\n');
                                    }

                                    replyText = await queryGemini(
                                        freshConfig.geminiApiKey,
                                        freshConfig.geminiModel,
                                        messageContent,
                                        aiContact.talkingStyle,
                                        aiContact.senderContext,
                                        aiContact.contactContext,
                                        historyPrompt,
                                        knowledgeContext
                                    );
                                }

                                // Simulate composing presence with dynamic natural typing delays
                                try {
                                    await sock.sendPresenceUpdate('composing', msg.key.remoteJid);
                                } catch (e) {}

                                const delayMs = Math.max(1500, Math.min(5000, replyText.length * 50));
                                addSessionLog(userId, `Simulating natural typing delay: ${delayMs}ms for message length ${replyText.length}`);
                                await new Promise(r => setTimeout(r, delayMs));

                                await sock.sendMessage(msg.key.remoteJid, { text: replyText });
                                
                                const botJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : 'bot@s.whatsapp.net';
                                await saveChatLog(userId, msg.key.remoteJid, botJid, directMatch ? 'Direct Match' : 'Gemini AI', replyText, true);
                                addSessionLog(userId, `[Bot Replied] Sent auto-reply to ${displayName}`);

                                try {
                                    await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                                } catch (e) {}
                            } catch (gemErr) {
                                addSessionLog(userId, `[AI Error] Auto-reply flow failed: ${gemErr.message}`);
                                try {
                                    await sock.sendPresenceUpdate('paused', msg.key.remoteJid);
                                } catch (e) {}
                            }
                        }
                    }
                }
            }
        });
    } catch (err) {
        addSessionLog(userId, `Connection error initializing bot: ${err.message}`);
        session.sock = null;
        session.status = 'disconnected';
    }
}

// Autostart active WhatsApp bots in database on boot
async function autoStartAllBots() {
    try {
        if (!supabaseUrl || !supabaseServiceRoleKey) {
            console.warn('[Autostart] Supabase environment variables missing. Skipping auto-reconnect bots.');
            return;
        }

        const { data, error } = await supabaseAdmin
            .from('whatsapp_sessions')
            .select('user_id');

        if (error) {
            console.error('[Autostart] Error loading active WhatsApp sessions:', error);
            return;
        }

        console.log(`[Autostart] Restoring connections for ${data.length} active bots...`);
        for (const row of data) {
            console.log(`[Autostart] Initializing session reconnect for user: ${row.user_id}`);
            connectToWhatsApp(row.user_id).catch(err => {
                console.error(`[Autostart] Failed to reconnect user ${row.user_id}:`, err);
            });
        }
    } catch (err) {
        console.error('[Autostart] Error during bot auto-initialization:', err);
    }
}

// ── ENDPOINTS ──

// Real-Time Events SSE Connection
app.get('/api/events', requireAuthAPI, async (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const userId = req.user.id;
        const session = getOrCreateSession(userId);
        session.clients.add(res);

        // Auto-connect if no connection exists or is pending
        if (!session.sock && session.status !== 'connecting') {
            connectToWhatsApp(userId).catch(err => {
                console.error('Failed to trigger background connection:', err);
            });
        }

        // Send initial state snapshot
        res.write(`data: ${JSON.stringify({
            status: session.status,
            qrCode: session.qrCode,
            logs: session.logs
        })}\n\n`);

        req.on('close', () => {
            session.clients.delete(res);
        });
    } catch (err) {
        res.status(500).end();
    }
});

// Send Message Manual Request
app.post('/api/send', requireAuthAPI, async (req, res) => {
    let { to, message } = req.body;
    if (!to || !message) {
        return res.status(400).json({ success: false, error: 'Missing to or message parameters' });
    }

    const userId = req.user.id;
    const session = activeSessions.get(userId);

    if (!session || !session.sock || session.status !== 'connected') {
        return res.status(400).json({ success: false, error: 'WhatsApp bot connection is not active.' });
    }

    try {
        let jid = to.trim();
        if (!jid.includes('@')) {
            jid = `${jid}@s.whatsapp.net`;
        }

        await session.sock.sendMessage(jid, { text: message });
        
        const botJid = session.sock.user?.id ? (session.sock.user.id.split(':')[0] + '@s.whatsapp.net') : 'bot@s.whatsapp.net';
        await saveChatLog(userId, jid, botJid, 'System Bot (Manual)', message, true);
        addSessionLog(userId, `Manually sent message to ${jid}: ${message}`);

        return res.json({ success: true });
    } catch (err) {
        addSessionLog(userId, `Failed manual message send: ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Fetch Connection Status
app.get('/api/whatsapp/status', requireAuthAPI, (req, res) => {
    const session = getOrCreateSession(req.user.id);
    return res.json({
        success: true,
        status: session.status,
        qrCode: session.qrCode
    });
});

// Disconnect Bot Endpoint
app.post('/api/whatsapp/disconnect', requireAuthAPI, async (req, res) => {
    const userId = req.user.id;
    const session = getOrCreateSession(userId);

    if (session.reconnectTimeout) {
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = null;
    }

    if (session.sock) {
        try {
            await session.sock.logout();
        } catch (err) {
            try {
                session.sock.end();
            } catch (e) {}
        }
    }

    await supabaseAdmin
        .from('whatsapp_sessions')
        .delete()
        .eq('user_id', userId);

    session.sock = null;
    session.status = 'disconnected';
    session.qrCode = '';
    broadcastToUser(userId, { status: 'disconnected', qrCode: '' });
    addSessionLog(userId, 'Logged out and deleted WhatsApp auth session credentials.');

    // Auto start fresh connection scan QR
    setTimeout(() => {
        connectToWhatsApp(userId).catch(err => {
            console.error('Error auto-restarting WhatsApp after disconnect:', err);
        });
    }, 1000);

    return res.json({ success: true });
});

// Clear conversation logs for a JID
app.delete('/api/chats/:jid', requireAuthAPI, async (req, res) => {
    const userId = req.user.id;
    const { jid } = req.params;

    if (!jid) {
        return res.status(400).json({ success: false, error: 'Missing JID' });
    }

    try {
        const { error } = await supabaseAdmin
            .from('chat_logs')
            .delete()
            .eq('user_id', userId)
            .eq('chat_jid', jid);

        if (error) throw error;

        // Broadcast delete event via SSE
        broadcastToUser(userId, { type: 'chat_clear', chat_jid: jid });

        addSessionLog(userId, `Cleared chat history logs for contact: ${jid}`);
        return res.json({ success: true });
    } catch (err) {
        addSessionLog(userId, `Failed to clear chat logs for ${jid}: ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`Bot daemon listening at: http://localhost:${PORT}`);
    console.log(`==================================================\n`);
    autoStartAllBots();
});
