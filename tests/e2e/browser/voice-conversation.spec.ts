/** Voice conversation in Chromium. Scenarios: voice-conversation-helpers.ts. */
import { test } from '@playwright/test'
import { registerVoiceConversationScenarios } from './voice-conversation-helpers'

test.skip(({ browserName }) => browserName !== 'chromium', 'WebKit runs voice-conversation.webkit.spec.ts')

registerVoiceConversationScenarios()
