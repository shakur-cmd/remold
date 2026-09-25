export function cadence(plan: {
    start: number;
    interval: 'day' | 'month';
}, index: number): number {
    if (!Number.isSafeInteger(plan.start) || !Number.isInteger(index) || index < 0 || index > 3)
        throw Error('Invalid finite cadence');
    const date = new Date(plan.start * 1000);
    if (!Number.isFinite(date.getTime()))
        throw Error('Invalid cadence timestamp');
    if (plan.interval === 'month') {
        if (date.getUTCDate() > 28)
            throw Error('Month anchor beyond bounded proof');
        date.setUTCMonth(date.getUTCMonth() + index);
    }
    else if (plan.interval === 'day')
        date.setUTCDate(date.getUTCDate() + index);
    else
        throw Error('Unsupported cadence');
    return date.getTime() / 1000;
}
