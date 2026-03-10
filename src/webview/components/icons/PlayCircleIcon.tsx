export function PlayCircleIcon({
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
      <path
        fill={color}
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m-2 14.5v-9l6 4.5z"
      />
    </svg>
  );
}
