// Neutral fixtures matching a short advisory plus long HTML and a long event promotion.
export const largeRouterMails = [
  {
    name: 'repository advisory',
    sender: 'notifications@code.example.invalid',
    subject: 'A security advisory affects one repository',
    text: 'One repository may be affected by a high severity signature vulnerability.\nRepository: example/old-project\nAlert: 258\nReview the affected dependency.',
    html: `<html><head><style>${'.layout { color: black; }'.repeat(1800)}</style></head><body><p>Review the affected dependency.</p></body></html>`,
    payload: { bulkHeaders: { precedence: 'bulk', autoSubmitted: 'auto-generated' } },
  },
  {
    name: 'event promotion',
    sender: 'events@conference.example.invalid',
    subject: 'The annual conference starts Tuesday. Register now.',
    text: 'Get your digital pass. Register now to watch the opening keynote online.\n' + 'Explore sessions and speakers. '.repeat(250),
    html: `<html><head><style>${'.layout { color: black; }'.repeat(1400)}</style></head><body><h1>Register now</h1><p>Get your digital pass.</p></body></html>`,
    payload: { listUnsubscribe: { https: ['https://conference.example.invalid/unsubscribe'], oneClick: true, listId: 'events.conference.example.invalid' }, bulkHeaders: { precedence: 'bulk' } },
  },
] as const;
