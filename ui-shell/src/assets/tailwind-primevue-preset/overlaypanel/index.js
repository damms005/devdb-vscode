export default {
    root: {
        class: [
            // Shape
            'rounded-lg',
            'shadow-xl',
            'border-0 dark:border',

            // Position
            'absolute left-0 top-0 mt-2',
            'z-40 transform origin-center',

            // Color
            'bg-surface-0 dark:bg-surface-800',
            'text-surface-700 dark:text-surface-0/80',
            'dark:border-surface-700',

            // Before: Triangle
            'before:absolute before:-top-2 before:ml-4 before:z-50',
            'before:w-0 before:h-0 before:shadow-xl',
            'before:border-transparent before:border-solid',
            'before:border-x-[0.5rem] before:border-b-[0.5rem]',
            'before:border-t-0 before:border-b-surface-0 dark:before:border-b-surface-800'
        ]
    },
    content: {
        class: 'p-6 items-center flex'
    },
    transition: {
        enterFromClass: 'opacity-0 scale-y-[0.8]',
        enterActiveClass: 'transition-[transform,opacity] duration-[120ms] ease-[cubic-bezier(0,0,0.2,1)]',
        leaveActiveClass: 'transition-opacity duration-100 ease-linear',
        leaveToClass: 'opacity-0'
    }
};
