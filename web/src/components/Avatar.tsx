/** Round initials badge; the colour comes from the address so each person keeps theirs. */
import { hueOf, initials } from "../format";

export function Avatar({ name, email, size }: { name?: string | null; email: string; size?: "sm" }) {
  return <span className={`avatar${size ? ` ${size}` : ""}`} aria-hidden style={{ ["--h" as string]: hueOf(email || name || "?") }}>{initials(name, email)}</span>;
}
