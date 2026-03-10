export function DoneIcon({
  color,
  width = 22,
  height = 22,
}: {
  color: string;
  width?: number;
  height?: number;
}) {
  return (
    <svg width={width} height={height} focusable="false" aria-hidden="true" viewBox="0 0 24 24">
      <path fill={color} d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" />
    </svg>
  );
}
