import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/*
 * shadcn/ui's base-nova components import { cn } from the npm package "cn", and `shadcn add`
 * installs that package into dependencies but not @base-ui/react. After every `shadcn add`:
 * point those imports here (from "@/lib/utils"), uninstall "cn", and install what the new
 * component imports with -D, so frontend/package.json dependencies stay main-process only.
 */

/** Joins class names and lets a later Tailwind utility replace a conflicting earlier one. */
export function cn(...inputs: ClassValue[]): string {
    return twMerge(clsx(inputs));
}
