# Heartbeat Checklist

This file is read by Walnut's heartbeat system every 30 minutes (configurable).
The AI agent evaluates each item and decides whether to notify you.

If nothing needs attention, reply exactly: HEARTBEAT_OK

## Checks

- Review any completed sessions — summarize results if not already noted
- Check for tasks marked IN_PROGRESS that have been stale for over 24 hours
- If a high-priority task has no active session, consider flagging it
- Review today's daily log for any unresolved items

## Notes
- Only notify the user if something genuinely needs their attention
- Do NOT repeat information that was already communicated
- Keep notifications concise (2-3 sentences max)
