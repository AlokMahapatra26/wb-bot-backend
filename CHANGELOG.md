# Changelog

All notable changes to the WhatsApp AI Bot Daemon will be documented in this file.

## [1.1.0] - 2026-06-18

### Added
- Real-time client messaging state updates via Server-Sent Events (SSE) broadcasting.
- Event broadcasting inside `saveChatLog` when chat logs are successfully inserted using Supabase PostgreSQL.
- Broadcast clear chat event (`chat_clear`) to notify connected web clients when a conversation is deleted.

### Changed
- Refactored `saveChatLog` to utilize the `.select()` query modifier to fetch the inserted database record for real-time dispatch.
