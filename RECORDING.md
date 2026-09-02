# The 45 second video

This is the launch asset. The repository is not.

## The claim being demonstrated

**Drift, not exfiltration.**

Testing on 2 September 2026 showed Claude Desktop refusing injected instructions in tool descriptions and warning the user about them unprompted. Twice, including a subtle payload with no urgency markers and a plausible cover story.

So do not film a leak. It did not happen, staging it would be the fastest way to lose every reader who tries to reproduce it, and the true version is strong enough:

> The definition changed between sessions and nothing told you.

## Shot list

| Time | Shot |
|---|---|
| 0:00 to 0:06 | Config on screen. Approve the demo server. Show the approval dialog clearly. |
| 0:06 to 0:12 | Ask for the weather. Normal answer. Everything looks fine. |
| 0:12 to 0:16 | Black card: "restart. same server. nothing reinstalled." |
| 0:16 to 0:26 | Ask again. Normal answer again. Cut to the tool description side by side with the approved one. They differ. No prompt, no warning, no re-approval. Hold this shot. |
| 0:26 to 0:30 | Black card: "your client approved a tool once and never looked again." |
| 0:30 to 0:45 | Same config wrapped in `npx mcp-pin --`. Restart. Red diff, session blocked. |

## Rules

- Terminal font 18pt or larger. It will be watched on a phone.
- Hold the diff long enough to read one changed line. Resist cutting on the beat.
- No music, no voiceover, no face, no intro card with your name.
- Ship the demo server source in the repository. People assume staging unless they can run it themselves.
- No call to action beyond the repository link.

## Why the silence works

The strongest moment is 0:16 to 0:26, where nothing happens. No alert, no dialog, no colour change. That absence is the argument, and narration would weaken it.
