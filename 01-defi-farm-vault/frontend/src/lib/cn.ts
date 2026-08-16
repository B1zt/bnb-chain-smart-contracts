import {clsx, type ClassValue} from 'clsx';
import {twMerge} from 'tailwind-merge';

/**
 * Merge class names, with later Tailwind utilities winning over earlier conflicting ones.
 *
 * Plain `clsx` would emit both `px-3` and `px-6` and leave the winner to CSS source order, which is
 * unpredictable once a component accepts a `className` override. `twMerge` resolves the conflict.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
