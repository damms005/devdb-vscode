export default {
    root: ({ props }) => ({
        class: [
            // Flexbox and Position
            'inline-flex',
            'relative',

            // Shape
            'rounded-md',
            { 'shadow-lg': props.raised }
        ]
    }),
    button: {
        root: ({ parent }) => ({
            class: [
                'relative',
                // Alignments
                'items-center inline-flex text-center align-bottom justify-center',

                // Sizes & Spacing
                'text-sm',
                {
                    'px-2.5 py-1.5 min-w-[2rem]': parent.props.size === null && parent.props.label !== null,
                    'px-2 py-1': parent.props.size === 'small',
                    'px-3 py-2': parent.props.size === 'large'
                },
                {
                    'h-8 w-8 p-0': parent.props.label == null
                },

                // Shape
                'rounded-r-none',
                'border-r-0',
                { 'rounded-l-full': parent.props.rounded },
                { 'rounded-md': !parent.props.rounded, 'rounded-full': parent.props.rounded },

                // Link Button
                { 'text-primary-600 bg-transparent ring-transparent': parent.props.link },

                // Plain Button
                { 'text-white bg-gray-500 ring-1 ring-gray-500': parent.props.plain && !parent.props.outlined && !parent.props.text },
                // Plain Text Button
                { 'text-surface-500': parent.props.plain && parent.props.text },
                // Plain Outlined Button
                { 'text-surface-500 ring-1 ring-gray-500': parent.props.plain && parent.props.outlined },

                // Text Button
                { 'bg-transparent ring-transparent': parent.props.text && !parent.props.plain },

                // Outlined Button
                { 'bg-transparent': parent.props.outlined && !parent.props.plain },

                // --- Severity Buttons ---

                // Primary Button
                {
                    'text-white dark:text-surface-900': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-primary-500 dark:bg-primary-400': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-primary-500 dark:ring-primary-400': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Primary Text Button
                { 'text-primary-500 dark:text-primary-400': parent.props.text && parent.props.severity === null && !parent.props.plain },
                // Primary Outlined Button
                { 'text-primary-500 ring-1 ring-primary-500 hover:bg-primary-300/20': parent.props.outlined && parent.props.severity === null && !parent.props.plain },

                // Secondary Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-surface-500 dark:bg-surface-400': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-surface-500 dark:ring-surface-400': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Secondary Text Button
                { 'text-surface-500 dark:text-surface-400': parent.props.text && parent.props.severity === 'secondary' && !parent.props.plain },
                // Secondary Outlined Button
                { 'text-surface-500 ring-1 ring-surface-500 hover:bg-surface-300/20': parent.props.outlined && parent.props.severity === 'secondary' && !parent.props.plain },

                // Success Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-green-500 dark:bg-green-400': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-green-500 dark:ring-green-400': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Success Text Button
                { 'text-surface-500 dark:text-surface-400': parent.props.text && parent.props.severity === 'secondary' && !parent.props.plain },
                // Success Outlined Button
                { 'text-green-500 ring-1 ring-green-500 hover:bg-green-300/20': parent.props.outlined && parent.props.severity === 'success' && !parent.props.plain },

                // Info Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-blue-500 dark:bg-blue-400': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-blue-500 dark:ring-blue-400': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Info Text Button
                { 'text-blue-500 dark:text-blue-400': parent.props.text && parent.props.severity === 'info' && !parent.props.plain },
                // Info Outlined Button
                { 'text-blue-500 ring-1 ring-blue-500 hover:bg-blue-300/20 ': parent.props.outlined && parent.props.severity === 'info' && !parent.props.plain },

                // Warning Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-orange-500 dark:bg-orange-400': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-orange-500 dark:ring-orange-400': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Warning Text Button
                { 'text-orange-500 dark:text-orange-400': parent.props.text && parent.props.severity === 'warning' && !parent.props.plain },
                // Warning Outlined Button
                { 'text-orange-500 ring-1 ring-orange-500 hover:bg-orange-300/20': parent.props.outlined && parent.props.severity === 'warning' && !parent.props.plain },

                // Help Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-purple-500 dark:bg-purple-400': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-purple-500 dark:ring-purple-400': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Help Text Button
                { 'text-purple-500 dark:text-purple-400': parent.props.text && parent.props.severity === 'help' && !parent.props.plain },
                // Help Outlined Button
                { 'text-purple-500 ring-1 ring-purple-500 hover:bg-purple-300/20': parent.props.outlined && parent.props.severity === 'help' && !parent.props.plain },

                // Danger Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-red-500 dark:bg-red-400': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-red-500 dark:ring-red-400': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Danger Text Button
                { 'text-red-500 dark:text-red-400': parent.props.text && parent.props.severity === 'danger' && !parent.props.plain },
                // Danger Outlined Button
                { 'text-red-500 ring-1 ring-red-500 hover:bg-red-300/20': parent.props.outlined && parent.props.severity === 'danger' && !parent.props.plain },

                // --- Severity Button States ---
                'focus:outline-none focus:outline-offset-0 focus:ring-2 focus:ring-offset-current',
                { 'focus:ring-offset-2': !parent.props.link && !parent.props.plain && !parent.props.outlined && !parent.props.text },

                // Link
                { 'focus:ring-primary-500 dark:focus:ring-primary-400': parent.props.link },

                // Plain
                { 'hover:bg-gray-600 hover:ring-gray-600': parent.props.plain && !parent.props.outlined && !parent.props.text },
                // Text & Outlined Button
                { 'hover:bg-surface-300/20': parent.props.plain && (parent.props.text || parent.props.outlined) },

                // Primary
                { 'hover:bg-primary-600 dark:hover:bg-primary-300 hover:ring-primary-600 dark:hover:ring-primary-300': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-primary-500 dark:focus:ring-primary-400': parent.props.severity === null },
                // Text & Outlined Button
                { 'hover:bg-primary-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === null && !parent.props.plain },

                // Secondary
                { 'hover:bg-surface-600 dark:hover:bg-surface-300 hover:ring-surface-600 dark:hover:ring-surface-300': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-surface-500 dark:focus:ring-surface-400': parent.props.severity === 'secondary' },
                // Text & Outlined Button
                { 'hover:bg-surface-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'secondary' && !parent.props.plain },

                // Success
                { 'hover:bg-green-600 dark:hover:bg-green-300 hover:ring-green-600 dark:hover:ring-green-300': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-green-500 dark:focus:ring-green-400': parent.props.severity === 'success' },
                // Text & Outlined Button
                { 'hover:bg-green-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'success' && !parent.props.plain },

                // Info
                { 'hover:bg-blue-600 dark:hover:bg-blue-300 hover:ring-blue-600 dark:hover:ring-blue-300': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-blue-500 dark:focus:ring-blue-400': parent.props.severity === 'info' },
                // Text & Outlined Button
                { 'hover:bg-blue-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'info' && !parent.props.plain },

                // Warning
                { 'hover:bg-orange-600 dark:hover:bg-orange-300 hover:ring-orange-600 dark:hover:ring-orange-300': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-orange-500 dark:focus:ring-orange-400': parent.props.severity === 'warning' },
                // Text & Outlined Button
                { 'hover:bg-orange-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'warning' && !parent.props.plain },

                // Help
                { 'hover:bg-purple-600 dark:hover:bg-purple-300 hover:ring-purple-600 dark:hover:ring-purple-300': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-purple-500 dark:focus:ring-purple-400': parent.props.severity === 'help' },
                // Text & Outlined Button
                { 'hover:bg-purple-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'help' && !parent.props.plain },

                // Warning
                { 'hover:bg-red-600 dark:hover:bg-red-300 hover:ring-red-600 dark:hover:ring-red-300': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-red-500 dark:focus:ring-red-400': parent.props.severity === 'danger' },
                // Text & Outlined Button
                { 'hover:bg-red-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'danger' && !parent.props.plain },

                // Transitions
                'transition duration-200 ease-in-out',

                // Misc
                'cursor-pointer overflow-hidden select-none'
            ]
        }),
        icon: {
            class: [
                // Margins
                'mr-2'
            ]
        }
    },
    menubutton: {
        root: ({ parent }) => ({
            class: [
                'relative',

                // Alignments
                'items-center inline-flex text-center align-bottom justify-center',

                // Sizes & Spacing
                'text-sm',
                {
                    'px-2.5 py-1.5 min-w-[2rem]': parent.props.size === null && parent.props.label !== null,
                    'px-2 py-1': parent.props.size === 'small',
                    'px-3 py-2': parent.props.size === 'large'
                },
                {
                    'h-8 w-8 p-0': parent.props.label == null
                },
                'ml-[1px]',

                // Shape
                'rounded-l-none',
                { 'rounded-l-full': parent.props.rounded },
                { 'rounded-md': !parent.props.rounded, 'rounded-full': parent.props.rounded },

                // Link Button
                { 'text-primary-600 bg-transparent ring-transparent': parent.props.link },

                // Plain Button
                { 'text-white bg-gray-500 ring-1 ring-gray-500': parent.props.plain && !parent.props.outlined && !parent.props.text },
                // Plain Text Button
                { 'text-surface-500': parent.props.plain && parent.props.text },
                // Plain Outlined Button
                { 'text-surface-500 ring-1 ring-gray-500': parent.props.plain && parent.props.outlined },

                // Text Button
                { 'bg-transparent ring-transparent': parent.props.text && !parent.props.plain },

                // Outlined Button
                { 'bg-transparent': parent.props.outlined && !parent.props.plain },

                // --- Severity Buttons ---

                // Primary Button
                {
                    'text-white dark:text-surface-900': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-primary-500 dark:bg-primary-400': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-primary-500 dark:ring-primary-400': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Primary Text Button
                { 'text-primary-500 dark:text-primary-400': parent.props.text && parent.props.severity === null && !parent.props.plain },
                // Primary Outlined Button
                { 'text-primary-500 ring-1 ring-primary-500 hover:bg-primary-300/20': parent.props.outlined && parent.props.severity === null && !parent.props.plain },

                // Secondary Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-surface-500 dark:bg-surface-400': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-surface-500 dark:ring-surface-400': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Secondary Text Button
                { 'text-surface-500 dark:text-surface-400': parent.props.text && parent.props.severity === 'secondary' && !parent.props.plain },
                // Secondary Outlined Button
                { 'text-surface-500 ring-1 ring-surface-500 hover:bg-surface-300/20': parent.props.outlined && parent.props.severity === 'secondary' && !parent.props.plain },

                // Success Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-green-500 dark:bg-green-400': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-green-500 dark:ring-green-400': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Success Text Button
                { 'text-surface-500 dark:text-surface-400': parent.props.text && parent.props.severity === 'secondary' && !parent.props.plain },
                // Success Outlined Button
                { 'text-green-500 ring-1 ring-green-500 hover:bg-green-300/20': parent.props.outlined && parent.props.severity === 'success' && !parent.props.plain },

                // Info Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-blue-500 dark:bg-blue-400': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-blue-500 dark:ring-blue-400': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Info Text Button
                { 'text-blue-500 dark:text-blue-400': parent.props.text && parent.props.severity === 'info' && !parent.props.plain },
                // Info Outlined Button
                { 'text-blue-500 ring-1 ring-blue-500 hover:bg-blue-300/20 ': parent.props.outlined && parent.props.severity === 'info' && !parent.props.plain },

                // Warning Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-orange-500 dark:bg-orange-400': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-orange-500 dark:ring-orange-400': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Warning Text Button
                { 'text-orange-500 dark:text-orange-400': parent.props.text && parent.props.severity === 'warning' && !parent.props.plain },
                // Warning Outlined Button
                { 'text-orange-500 ring-1 ring-orange-500 hover:bg-orange-300/20': parent.props.outlined && parent.props.severity === 'warning' && !parent.props.plain },

                // Help Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-purple-500 dark:bg-purple-400': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-purple-500 dark:ring-purple-400': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Help Text Button
                { 'text-purple-500 dark:text-purple-400': parent.props.text && parent.props.severity === 'help' && !parent.props.plain },
                // Help Outlined Button
                { 'text-purple-500 ring-1 ring-purple-500 hover:bg-purple-300/20': parent.props.outlined && parent.props.severity === 'help' && !parent.props.plain },

                // Danger Button
                {
                    'text-white dark:text-surface-900': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'bg-red-500 dark:bg-red-400': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain,
                    'ring-1 ring-red-500 dark:ring-red-400': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain
                },
                // Danger Text Button
                { 'text-red-500 dark:text-red-400': parent.props.text && parent.props.severity === 'danger' && !parent.props.plain },
                // Danger Outlined Button
                { 'text-red-500 ring-1 ring-red-500 hover:bg-red-300/20': parent.props.outlined && parent.props.severity === 'danger' && !parent.props.plain },

                // --- Severity Button States ---
                'focus:outline-none focus:outline-offset-0 focus:ring-2 focus:ring-offset-current',
                { 'focus:ring-offset-2': !parent.props.link && !parent.props.plain && !parent.props.outlined && !parent.props.text },

                // Link
                { 'focus:ring-primary-500 dark:focus:ring-primary-400': parent.props.link },

                // Plain
                { 'hover:bg-gray-600 hover:ring-gray-600': parent.props.plain && !parent.props.outlined && !parent.props.text },
                // Text & Outlined Button
                { 'hover:bg-surface-300/20': parent.props.plain && (parent.props.text || parent.props.outlined) },

                // Primary
                { 'hover:bg-primary-600 dark:hover:bg-primary-300 hover:ring-primary-600 dark:hover:ring-primary-300': !parent.props.link && parent.props.severity === null && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-primary-500 dark:focus:ring-primary-400': parent.props.severity === null },
                // Text & Outlined Button
                { 'hover:bg-primary-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === null && !parent.props.plain },

                // Secondary
                { 'hover:bg-surface-600 dark:hover:bg-surface-300 hover:ring-surface-600 dark:hover:ring-surface-300': parent.props.severity === 'secondary' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-surface-500 dark:focus:ring-surface-400': parent.props.severity === 'secondary' },
                // Text & Outlined Button
                { 'hover:bg-surface-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'secondary' && !parent.props.plain },

                // Success
                { 'hover:bg-green-600 dark:hover:bg-green-300 hover:ring-green-600 dark:hover:ring-green-300': parent.props.severity === 'success' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-green-500 dark:focus:ring-green-400': parent.props.severity === 'success' },
                // Text & Outlined Button
                { 'hover:bg-green-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'success' && !parent.props.plain },

                // Info
                { 'hover:bg-blue-600 dark:hover:bg-blue-300 hover:ring-blue-600 dark:hover:ring-blue-300': parent.props.severity === 'info' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-blue-500 dark:focus:ring-blue-400': parent.props.severity === 'info' },
                // Text & Outlined Button
                { 'hover:bg-blue-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'info' && !parent.props.plain },

                // Warning
                { 'hover:bg-orange-600 dark:hover:bg-orange-300 hover:ring-orange-600 dark:hover:ring-orange-300': parent.props.severity === 'warning' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-orange-500 dark:focus:ring-orange-400': parent.props.severity === 'warning' },
                // Text & Outlined Button
                { 'hover:bg-orange-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'warning' && !parent.props.plain },

                // Help
                { 'hover:bg-purple-600 dark:hover:bg-purple-300 hover:ring-purple-600 dark:hover:ring-purple-300': parent.props.severity === 'help' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-purple-500 dark:focus:ring-purple-400': parent.props.severity === 'help' },
                // Text & Outlined Button
                { 'hover:bg-purple-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'help' && !parent.props.plain },

                // Warning
                { 'hover:bg-red-600 dark:hover:bg-red-300 hover:ring-red-600 dark:hover:ring-red-300': parent.props.severity === 'danger' && !parent.props.text && !parent.props.outlined && !parent.props.plain },
                { 'focus:ring-red-500 dark:focus:ring-red-400': parent.props.severity === 'danger' },
                // Text & Outlined Button
                { 'hover:bg-red-300/20': (parent.props.text || parent.props.outlined) && parent.props.severity === 'danger' && !parent.props.plain },

                // Transitions
                'transition duration-200 ease-in-out',

                // Misc
                'cursor-pointer overflow-hidden select-none'
            ]
        }),
        label: {
            class: ['hidden']
        }
    }
};
