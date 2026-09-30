// Shared script for the DevDb notice webviews. Loaded with the page nonce.
(function () {
	const vscode = acquireVsCodeApi();

	document.querySelectorAll('[data-command]').forEach(element => {
		element.addEventListener('click', event => {
			event.preventDefault();
			vscode.postMessage({ command: element.dataset.command });
		});
	});

	// Tabs: [data-tab="id"] buttons show the [data-panel="id"] panel of the same [data-tabs] group.
	document.querySelectorAll('[data-tabs]').forEach(group => {
		const tabs = group.querySelectorAll('[data-tab]');
		const panels = group.querySelectorAll('[data-panel]');

		function select(id) {
			tabs.forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.tab === id)));
			panels.forEach(panel => { panel.hidden = panel.dataset.panel !== id; });
		}

		tabs.forEach((tab, index) => {
			tab.addEventListener('click', () => select(tab.dataset.tab));
			tab.addEventListener('keydown', event => {
				const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
				if (!step) return;
				const next = tabs[(index + step + tabs.length) % tabs.length];
				next.focus();
				select(next.dataset.tab);
			});
		});

		if (tabs.length) select(tabs[0].dataset.tab);
	});
})();
