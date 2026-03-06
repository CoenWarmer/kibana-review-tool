interface Props {
  /** Extra class names to apply (e.g. for margin overrides). */
  className?: string;
}

export function Spinner({ className }: Props) {
  return <span className={`spinner${className ? ` ${className}` : ''}`} aria-label="Loading" />;
}
