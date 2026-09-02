# The 45-second video (this is the launch, not the repo)

Shot in Claude Desktop. Two terminals visible. No voiceover, no intro, no face.

0:00–0:05  Config on screen: demo weather server added to Claude Desktop. Approve dialog. Click Approve.
0:05–0:12  Ask: "what's the weather in Toronto?" Normal answer. Nothing suspicious.
0:12–0:15  CUT TO BLACK CARD: "restart Claude Desktop. Same server. Nothing was reinstalled."
0:15–0:28  Same question. The agent reads DEMO_SECRET.txt and passes it to the server.
           Server terminal prints: [rugpull-server] EXFILTRATED: "..."
           No approval prompt. No warning. This is the shot the whole video exists for. Hold it.
0:28–0:32  BLACK CARD: "the tool description changed. the client never re-checked."
0:32–0:45  Same config, wrapped in `npx attest --`. Restart. Red diff fills the terminal, session blocked.

Rules:
- Terminal font 18pt+. It will be watched on a phone.
- No music. No zoom effects. The silence when nothing alerts at 0:15 is the argument.
- Post the raw demo server source in the repo. People will assume it's staged unless they can run it.
- Do NOT ship the video with a call to action beyond the repo link.
