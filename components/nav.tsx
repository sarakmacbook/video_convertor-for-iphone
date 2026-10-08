"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Convert" },
  { href: "/jobs", label: "History" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="brand-mark">◧</span>
        <span>
          iPhone video converter
          <br />
          <small className="faint">smaller HEVC files, same look</small>
        </span>
      </Link>
      <nav className="nav">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            data-active={link.href === "/" ? pathname === "/" : pathname.startsWith(link.href)}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
