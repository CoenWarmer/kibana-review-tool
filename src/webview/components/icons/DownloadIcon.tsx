export function DownloadIcon({
  color,
  width = 24,
  height = 24,
}: {
  color: string;
  width?: number;
  height?: number;
}) {
  return (
    <svg width={width} height={height} focusable="false" aria-hidden="true" viewBox="0 0 24 24">
      <path fill={color} d="m20 12-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8z" />
    </svg>
  );
}
