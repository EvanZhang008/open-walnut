import { describe, expect, it } from 'vitest';
import { isTeamCodeAsk, USER_KIND_WORDS, NOT_THE_USERS_DECISION } from '../../../src/core/org/user-kind.js';

const OWN = "It publishes a change request in the team's own package";
// A log-only code change, with invented component and configuration data.
export const LOG_ASK = '\u6211\u6765\u5f00\u4e2a\u5c0f\u6539\u52a8\uff0c\u628a Meadow Widget \u65e5\u5fd7\u91cc\u7684\u8c03\u8bd5\u914d\u7f6e\u53bb\u6389\uff08\u53ea\u6539\u65e5\u5fd7\uff0c\u4e0d\u6539\u5224\u65ad\u903b\u8f91\uff09\uff0c\u53ef\u4ee5\u5417\uff1f';

describe('team code asks mislabeled outward', () => {
  it.each([
    [LOG_ASK, OWN],
    ["Open a change request in the team's own package?", 'It publishes a code review'],
    ["Publish the CR in our own repository?", 'It publishes the code review for review'],
    ["Commit the logging fix in our own repo?", 'It commits the patch'],
    ["Change the logging code in our own package?", 'It edits the code'],
    ['\u5728\u56e2\u961f\u81ea\u5df1\u7684\u4ed3\u5e93\u63d0\u4ea4\u4ee3\u7801\u5ba1\u67e5\uff0c\u53ef\u4ee5\u5417\uff1f', '\u53d1\u5e03\u4ee3\u7801\u5ba1\u67e5'],
  ])('recognizes only explicitly owned code work: %s', (ask, why) => {
    expect(isTeamCodeAsk(ask, why)).toBe(true);
  });

  it.each([
    ['Publish the change request?', 'It publishes a code review'],
    ["Open a change request in another team's package?", 'It publishes a code review'],
    ['', OWN],
    ['Can I proceed?', ''],
    ['Send the reviewer an email about the change request?', OWN],
    ['Open the CR and post the summary to Slack?', OWN],
    ['Commit the fix and push it to public GitHub?', OWN],
    ['Publish the CR and release the package to npm?', OWN],
    ['Open the CR and buy a paid build plan?', OWN],
    ['Open the CR using a new credential?', OWN],
    ['Open the CR and grant repository access?', OWN],
    ['Open the CR and delete the cloud bucket?', OWN],
    ['Open the CR and force-push the history?', OWN],
    ['Open the CR in our own repo and notify the vendor?', OWN],
    ['Upload the patch in our own repo to the vendor portal?', OWN],
    ['Transmit the code review in our own package?', OWN],
    ['Publish the patch in our own package?', 'It publishes the patch.'],
    ['Publish the code in our own repo?', 'It publishes the code.'],
    [LOG_ASK.replace('Meadow Widget', 'Meadow and then email the customer'), OWN],
    [LOG_ASK.replace('Meadow Widget', 'Meadow then push to public GitHub'), OWN],
    [LOG_ASK.replace('\u8c03\u8bd5', '\u5220\u9664\u4e91\u8d44\u6e90'), OWN],
    ['Open the CR in our own repo?', `${OWN}; then upload the patch`],
    [LOG_ASK, `${OWN}; it also sends the customer a message`],
    [`${LOG_ASK}\u7136\u540e\u53d1\u90ae\u4ef6\u7ed9\u5ba2\u6237`, OWN],
    [`${LOG_ASK}\u5e76\u516c\u5f00\u63a8\u9001`, OWN],
  ])('keeps ambiguous scope and protected steps protected: %s', (ask, why) => {
    expect(isTeamCodeAsk(ask, why)).toBe(false);
  });

  it('reads the full ask details, including a protected step after a long code description', () => {
    expect(isTeamCodeAsk('Open the CR?', OWN, `${'Logging fix. '.repeat(400)}Send the customer an email.`)).toBe(false);
  });

  it('defines outward by leaving the team code, not by leaving Walnut', () => {
    expect(USER_KIND_WORDS.outward).toContain("team's own");
    expect(NOT_THE_USERS_DECISION).toContain('change request');
  });
});
