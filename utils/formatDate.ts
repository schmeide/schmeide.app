const medium = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export const formatDate = (date: Date): string => medium.format(date);
