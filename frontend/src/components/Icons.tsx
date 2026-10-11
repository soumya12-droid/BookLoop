import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (p: P): P => ({
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false, ...p,
});

export const LogoMark = (p: P) => (
  <svg {...base({ width: 30, height: 30, strokeWidth: 1.6, ...p })}>
    <path d="M3 6.5c3-1.4 6-1.2 9 .8v12c-3-2-6-2.2-9-.8v-12Z" />
    <path d="M21 6.5c-3-1.4-6-1.2-9 .8v12c3-2 6-2.2 9-.8v-12Z" />
    <path d="M12 7.3V4.6c.9-1 2.2-1.5 3.4-1.4" />
  </svg>
);
export const SearchIcon = (p: P) => (<svg {...base(p)}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg>);
export const MenuIcon = (p: P) => (<svg {...base(p)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>);
export const CloseIcon = (p: P) => (<svg {...base(p)}><path d="m6 6 12 12M18 6 6 18" /></svg>);
export const PlusIcon = (p: P) => (<svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>);
export const ArrowRight = (p: P) => (<svg {...base(p)}><path d="M5 12h14m-5-5 5 5-5 5" /></svg>);
export const CheckIcon = (p: P) => (<svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>);
export const ClockIcon = (p: P) => (<svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>);
export const BookIcon = (p: P) => (<svg {...base(p)}><path d="M5 4.5h10.5A2.5 2.5 0 0 1 18 7v12.5H7.5A2.5 2.5 0 0 1 5 17V4.5Z" /><path d="M5 17a2.5 2.5 0 0 1 2.5-2.5H18" /></svg>);
export const StackIcon = (p: P) => (<svg {...base(p)}><path d="m12 4 8 4-8 4-8-4 8-4Z" /><path d="m4 12 8 4 8-4M4 16l8 4 8-4" /></svg>);
export const LeafIcon = (p: P) => (<svg {...base(p)}><path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14" /><path d="M5 19c3-4 6-7 10-9" /></svg>);
export const UsersIcon = (p: P) => (<svg {...base(p)}><circle cx="9" cy="9" r="3.2" /><path d="M3 19c.4-3.2 2.8-5 6-5s5.6 1.8 6 5" /><path d="M16 6.4a3 3 0 0 1 0 5.2M18 14.4c1.6.6 2.7 2 3 4.6" /></svg>);
export const StarIcon = ({ filled = true, ...p }: P & { filled?: boolean }) => (
  <svg {...base({ strokeWidth: 1.4, fill: filled ? 'currentColor' : 'none', ...p })}>
    <path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8L12 3.6Z" />
  </svg>
);
export const HomeIcon = (p: P) => (<svg {...base(p)}><path d="m4 11 8-6.5 8 6.5v8a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8Z" /></svg>);
export const InboxIcon = (p: P) => (<svg {...base(p)}><path d="M4 13.5 6.5 5h11L20 13.5V19H4v-5.5Z" /><path d="M4 13.5h4.5a3.5 3.5 0 0 0 7 0H20" /></svg>);
export const UserIcon = (p: P) => (<svg {...base(p)}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.5-3.6 3.2-5.6 7-5.6s6.5 2 7 5.6" /></svg>);
export const HourglassIcon = (p: P) => (<svg {...base(p)}><path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 4 5 4 8.5s-4 4.5-4 8.5M16 3.5c0 4-4 5-4 8.5s4 4.5 4 8.5" /></svg>);
