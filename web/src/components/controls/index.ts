/**
 * The choice controls: one component per kind of control that picks a value
 * (.claude/skills/walnut-ui-requirements/standard.md, "Choice controls"; CSS in
 * styles/choice-controls.css). `tests/web/choice-controls-ratchet.test.ts` fails on a new one built
 * by hand.
 */
export { Tabs, TabList, Tab, type TabItem, type TabsProps, type TabProps } from './Tabs'
export { Chip, ChipGroup, type ChipProps } from './Chip'
export { Checkbox, Radio, type CheckboxProps, type RadioProps } from './Checkbox'
export { DisclosureButton, DisclosureChevron, MenuCaret, type DisclosureButtonProps } from './Disclosure'
export { ControlGroup, masterProps, type ControlGroupProps } from './ControlGroup'
export { SegmentedControl, SegmentedControl as Segmented, segmentIndexForKey, type SegmentedOption, type SegmentedControlProps } from '../settings/inputs/SegmentedControl'
export { ToggleSwitch } from '../settings/inputs/ToggleSwitch'
export { SettingsCheckbox } from '../settings/inputs/SettingsCheckbox'
