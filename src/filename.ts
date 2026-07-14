/** Canonical output name for a release: what the search list advertises, what
 *  the SAB queue/history reports, and what actually lands on disk should all
 *  agree on this. */
export function buildFilename(title: string, extension?: string): string {
  return extension ? `${title}.${extension}` : title;
}
