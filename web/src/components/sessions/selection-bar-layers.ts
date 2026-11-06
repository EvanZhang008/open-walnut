/**
 * Every layer the selection bar (QuotePinSelectionBar) draws: the bar itself and
 * the menu it opens (Ask here's choice, the Comment box), each portalled to <body>
 * on its own. A press in any of them is a press ON the bar, never "outside" a card,
 * a drawer or a popover. Name them through this, not by one class: when the menus
 * moved out of the bar into their own popover, the outside-press checks that only
 * knew `.quote-pin-pill` closed an open question card under a press on the menu.
 */
export const SELECTION_BAR_LAYERS = '.quote-pin-pill, .quote-pin-menu';
