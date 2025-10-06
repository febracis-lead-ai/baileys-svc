# **WhatsApp Baileys Multi-Session Service API/Webhook**
A standalone HTTP/Webhook microservice (built on Bun.js) that orchestrates multiple WhatsApp accounts via the Baileys v7 library. It provides REST endpoints and webhook events for:

* QR code / pairing code pairing
* Clean disconnection / logout
* Receiving messages (text, media)
* Sending messages (including replies / quoting)
* Media upload / download
* Read / delivery acknowledgments (ACK)
* Retrieving contact metadata (display name, profile picture)

The service is designed to be decoupled from your application, so your main system interacts via HTTP / webhooks rather than embedding direct WhatsApp logic.

> 🛑 **Important**: This implementation is **not affiliated** with WhatsApp, and use must comply with WhatsApp’s terms of service. Use responsibly and avoid spam or abusive messaging.
