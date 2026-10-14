# Thunder MAX

**Developed by Decan**

A lightweight WhatsApp bot with multi-session support and extensive configuration options.

## Get Started

#### 1. Pair Your WhatsApp Account

On an interactive terminal launch, choose to scan a QR code or request a WhatsApp pairing code. For pairing-code setup, enter your phone number with its country code. WhatsApp displays the code in the terminal. If `SESSION` is already configured, you can press Enter to start those sessions or choose to pair another account.

The pairing flow initializes and stores WhatsApp credentials in the configured database, then prints a compatible `SESSION=RGNK~...` value. Save it in your `.env` file after pairing so the same account is restored on later launches. When the linked account connects, Thunder MAX sends a startup message and its session ID to that account's own chat. When adding an account, the printed value includes your existing session entries.

**Important for Cloud Deployments:** If you're deploying on platforms like Render, Koyeb, Railway, or similar cloud services, you'll need a `DATABASE_URL` (PostgreSQL) for persistent storage. VPS deployments can use local file storage.

#### 2. Configure and run your bot

Run `npm start` in an interactive terminal to pair a new account or start configured sessions. After linking, save the printed `SESSION=RGNK~...` value in `.env`. Non-interactive launches with configured sessions connect automatically.

## Features

- Lightweight and fast performance
- Single and multi-session capabilities
- Supabase-backed session and bot-settings storage
- Extensive plugin system
- Group management tools
- Media download functionality
- Excellent caching and session management

## Prerequisites

- Node.js (version 20 or higher)
- Git
- FFmpeg
- npm or Yarn package manager
- PM2 (for process management)
- Database URL (postgreSQL - for cloud deployments)

## Installation

### Open the Project Folder

```bash
cd "THUNDER MAX"
```

Install PM2 globally if you want to run the bot as a managed process: `npm install -g pm2`.

### Install Dependencies

```bash
npm install
```

On Windows PowerShell, if script execution is restricted, run `npm.cmd install` instead. The project enables npm's legacy peer resolution because the existing Baileys release declares an optional Jimp peer version that differs from this project's Jimp version.

### Configuration

Create a local `.env` file in the root directory for any settings you want to customize. Never commit this file; it can contain WhatsApp session credentials. `SESSION` can be omitted for first-time terminal pairing.

#### Session Configuration

For an existing session:

```
SESSION=RGNK~d7a5s66
```

For multiple existing sessions:

```
SESSION=RGNK~d7a5s66,RGNK~7ad8cW
```

#### Required Variables

```
# Bot Configuration
BOT_NAME=Thunder MAX
HANDLERS=.,!
SUDO=919876543210

# Database (optional for local use; PostgreSQL URL required on cloud platforms)
# DATABASE_URL=postgres://user:password@host:5432/database

# Localization
LANGUAGE=en
TZ=Asia/Kolkata
```

## Running the Bot

```bash
npm start
```

## Process Management

The following PM2 commands apply when you started the bot with `pm2 start index.js --name THUNDER-MAX`.

```bash
# Stop bot
pm2 stop THUNDER-MAX

# Restart bot
pm2 restart THUNDER-MAX
```

After completing first-time pairing and saving `SESSION`, start the bot under PM2 with:

```bash
pm2 start index.js --name THUNDER-MAX
```

## Web Dashboard

The web dashboard source is not included in this public repository.

## Commands

Default prefix: `.`

- `.list` – Show available commands
- `.ping` – Check response time
- `.restart` – Restart bot (sudo only)
- `.shutdown` – Stop bot (sudo only)

## File Structure

```
thunder-max/
├── plugins/     # Bot plugins
├── core/        # Core libraries
├── output/      # Operational outputs
├── temp/        # Temporary files
├── config.js    # Configuration handler
├── index.js     # Main entry point
└── package.json # Dependencies
```

## Support

The web dashboard source is maintained separately and is not part of this public repository.

## Legal Notice

⚠️ **Use at your own risk.** This bot uses unofficial WhatsApp Web API methods and may result in temporary or permanent account bans.

- This code is in no way affiliated, authorized, maintained, sponsored or endorsed by WhatsApp or any of its affiliates.
- WhatsApp is a trademark of WhatsApp Inc., registered in the U.S. and other countries.
- This software is provided for educational and research purposes only
- Powered by [Baileys](https://github.com/WhiskeySockets/Baileys)

## License

GPL License - See LICENSE file for details.

---

**Note:** Some files are obfuscated for security reasons and should not be modified.
