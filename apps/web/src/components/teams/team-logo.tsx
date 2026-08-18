export function TeamLogo({
  logoUrl,
  name,
  size
}: {
  logoUrl: string | null;
  name: string;
  size: number;
}) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={logoUrl}
        alt={name}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role="img"
      aria-label={name}
      className="shrink-0 rounded-full"
    >
      <circle cx="24" cy="24" r="23" fill="#f8fafc" stroke="#cbd5e1" strokeWidth="1.5" />
      <path
        d="M8 14c6 4 6 16 0 20"
        fill="none"
        stroke="#dc2626"
        strokeWidth="1.5"
        strokeDasharray="2 2"
      />
      <path
        d="M40 14c-6 4-6 16 0 20"
        fill="none"
        stroke="#dc2626"
        strokeWidth="1.5"
        strokeDasharray="2 2"
      />
    </svg>
  );
}
