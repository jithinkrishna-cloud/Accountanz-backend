/** 'proposal_sent' → 'Proposal sent' (used in user-facing error and audit messages). */
export const humanize = (value: string) => value.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());
