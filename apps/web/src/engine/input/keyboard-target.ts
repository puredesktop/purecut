/** Controls keep their own editing and keyboard-navigation events. */
export function ownsKeyboardEvent(event: KeyboardEvent): boolean {
	if (event.defaultPrevented || event.isComposing || event.key === 'Tab') return true;
	const target = event.target;
	if (!(target instanceof Element)) return false;
	if (target instanceof HTMLElement && target.isContentEditable) return true;
	if (target.closest('[data-keyboard-scope], input, textarea, select, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"], [role="slider"], [role="spinbutton"]')) return true;
	return (event.key === ' ' || event.key === 'Enter') &&
		!!target.closest('button, a[href], [role="button"], [role="tab"], [role="checkbox"], [role="switch"]');
}
