// Studio Clyx wordmark + monogram. Geometric, brass on ink.
// Used inline so it inherits color from currentColor.

export function ClyxMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-label="Studio Clyx"
    >
      {/* Concentric apertures — referencing camera iris */}
      <circle cx="16" cy="16" r="13" />
      <path d="M16 3 V 9 M29 16 H 23 M16 29 V 23 M3 16 H 9" />
      <path d="M9.5 6.5 L 12 11 M22.5 6.5 L 20 11 M22.5 25.5 L 20 21 M9.5 25.5 L 12 21" />
      <circle cx="16" cy="16" r="4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ClyxLogo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="text-primary">
        <ClyxMark />
      </span>
      <div className="flex items-baseline gap-1.5">
        <span className="font-sans font-semibold tracking-tight text-base leading-none">
          Studio Clyx
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground leading-none">
          NYC
        </span>
      </div>
    </div>
  );
}
