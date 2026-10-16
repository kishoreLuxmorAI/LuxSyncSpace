import { z } from "zod";

export const gmailEmailSchema = z.string().trim().email().refine(
  (email) => email.split("@").at(-1)?.toLowerCase() === "gmail.com",
  "Email address must end with @gmail.com."
);