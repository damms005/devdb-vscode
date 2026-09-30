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
})();
