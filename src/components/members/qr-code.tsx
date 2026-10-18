// A QR code drawn from its modules (SetupLinkDTO qr, made on the server), so
// the page needs no QR library. Always dark on white with a quiet zone, which
// phone cameras need, whatever the theme.

const QUIET = 4;

export function QrCode({ qr, label, className }: { qr: { size: number; rows: string[] }; label: string; className?: string }) {
  const full = qr.size + QUIET * 2;
  let path = '';
  qr.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }
  });
  return (
    <svg
      viewBox={`0 0 ${full} ${full}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={full} height={full} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
