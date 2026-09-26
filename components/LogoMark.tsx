export default function LogoMark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="20" y="4" width="34" height="34" rx="9" fill="none" stroke="#a78bfa" strokeOpacity="0.4" strokeWidth="3" />
      <rect x="12" y="14" width="34" height="34" rx="9" fill="#a78bfa" fillOpacity="0.35" />
      <rect x="4" y="24" width="34" height="34" rx="9" fill="#7c3aed" />
    </svg>
  );
}
