// Shared script for the DevDb notice webviews. Loaded with the page nonce.
(function () {
	const vscode = acquireVsCodeApi();

	// Shortcuts show ⌘ on macOS and Ctrl elsewhere (.mac-only / .pc-only).
	const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
	if (!/mac/i.test(platform)) {
		document.body.classList.add('os-pc');
	}

	document.querySelectorAll('[data-command]').forEach(element => {
		element.addEventListener('click', event => {
			event.preventDefault();
			vscode.postMessage({ command: element.dataset.command });

			// data-done: short confirmation label, e.g. "Copied" on a copy button.
			if (element.dataset.done && !element.dataset.label) {
				element.dataset.label = element.textContent;
				element.textContent = element.dataset.done;
				setTimeout(() => {
					element.textContent = element.dataset.label;
					delete element.dataset.label;
				}, 1600);
			}
		});
	});

	// Deck: [data-deck-item] tabs bring their [data-deck-card] window to the front.
	// Auto-advance runs off the progress line's animationend; reduced motion turns it off.
	const deck = document.querySelector('[data-deck]');
	const items = Array.from(document.querySelectorAll('[data-deck-item]'));
	const cards = Array.from(document.querySelectorAll('[data-deck-card]'));
	if (deck && items.length && items.length === cards.length) {
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
		const BEHIND = 3;
		let active = 0;

		function show(index, focus) {
			active = (index + items.length) % items.length;
			cards.forEach((card, i) => {
				const depth = (i - active + cards.length) % cards.length;
				card.dataset.depth = depth <= BEHIND ? String(depth) : 'out';
			});
			items.forEach((item, i) => {
				const on = i === active;
				item.setAttribute('aria-selected', String(on));
				item.tabIndex = on ? 0 : -1;
				item.classList.remove('is-running');
			});
			deck.dataset.active = String(active);
			if (focus) items[active].focus();
			if (!reducedMotion.matches) {
				void items[active].offsetWidth; // restart the progress animation
				items[active].classList.add('is-running');
			}
		}

		const strip = items[0].closest('[role="tablist"]');
		const pause = paused => document.body.classList.toggle('deck-paused', paused);
		[deck, strip].forEach(area => {
			area.addEventListener('mouseenter', () => pause(true));
			area.addEventListener('mouseleave', () => pause(strip.contains(document.activeElement)));
		});
		strip.addEventListener('focusin', () => pause(true));
		strip.addEventListener('focusout', event => { if (!strip.contains(event.relatedTarget)) pause(false); });

		items.forEach((item, i) => {
			item.addEventListener('click', () => show(i, false));
			item.addEventListener('mouseenter', () => { if (i !== active) show(i, false); });
			item.addEventListener('animationend', event => { if (event.animationName === 'deck-progress' && i === active) show(active + 1, false); });
			item.addEventListener('keydown', event => {
				const keys = { ArrowRight: active + 1, ArrowDown: active + 1, ArrowLeft: active - 1, ArrowUp: active - 1, Home: 0, End: items.length - 1 };
				if (!(event.key in keys)) return;
				event.preventDefault();
				show(keys[event.key], true);
			});
		});
		reducedMotion.addEventListener('change', () => show(active, false));

		show(0, false);
	}
})();
