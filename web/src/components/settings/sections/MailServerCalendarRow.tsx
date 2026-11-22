/**
 * The row of a mail account whose calendar Walnut reads itself: from its mail server with its
 * password, or from Google or Microsoft with its sign-in. "Calendar here" (or "Not read" while
 * its source is down) and "Remove its calendar"; a signed-in one whose sign-in ended adds the
 * "Sign in again" its caller puts in `extra`.
 */
import type { ReactNode } from 'react'
import type { CalendarSourceStatus } from '@/api/calendar'
import { SettingsRow, SettingsTag } from '../SettingsSection'
import { SettingsButton } from '../inputs/SettingsButton'
import { mailServerCalendarHelp } from './calendar-mail-accounts'

interface Props {
  accountId: string
  label: string
  own: CalendarSourceStatus
  calendarCount: number
  /** What the last action on this row said (it wins over the status line). */
  said?: string
  provider?: 'Google' | 'Microsoft'
  /** A signed-in one: Remove leaves Walnut in the account's app list. */
  keepsGrant?: boolean
  /** The account whose action is under way, if any. */
  busy: string | null
  onRemove: () => void
  extra?: ReactNode
}

export function MailServerCalendarRow({ accountId, label, own, calendarCount, said, provider, keepsGrant, busy, onRemove, extra }: Props) {
  return (
    <SettingsRow
      data-testid={`calendar-mail-account-${accountId}`}
      data-match="server"
      label={label}
      help={said ?? mailServerCalendarHelp(own, calendarCount, provider, keepsGrant)}
      state={own.available || own.reason === 'disabled' ? undefined : 'warning'}
      control={
        <span className="settings-addons-inline">
          <SettingsTag tone={own.available ? 'success' : 'neutral'}>{own.available ? 'Calendar here' : 'Not read'}</SettingsTag>
          {extra}
          <SettingsButton
            variant="danger"
            busy={busy === accountId}
            busyLabel="Removing..."
            disabled={busy !== null && busy !== accountId}
            onClick={onRemove}
            data-testid={`calendar-mail-remove-${accountId}`}
          >
            Remove its calendar
          </SettingsButton>
        </span>
      }
    />
  )
}
