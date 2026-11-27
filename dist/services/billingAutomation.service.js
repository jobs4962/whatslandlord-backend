"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNewYorkDateStr = getNewYorkDateStr;
exports.getNewYorkDate = getNewYorkDate;
exports.calculateProratedFirstMonthRent = calculateProratedFirstMonthRent;
exports.calculateProratedLastMonthRent = calculateProratedLastMonthRent;
exports.parseDateUTC = parseDateUTC;
exports.generateAutoInvoices = generateAutoInvoices;
exports.generateAutoLateFees = generateAutoLateFees;
const database_1 = __importDefault(require("../config/database"));
const email_service_1 = require("./email.service");
// Helper function to get YYYY-MM-DD in America/New_York timezone
function getNewYorkDateStr(input) {
    const d = input ? (input instanceof Date ? input : new Date(input)) : new Date();
    if (isNaN(d.getTime())) {
        return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    }
    return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
// Helper function to get current Date at midnight (00:00:00 UTC) matching America/New_York timezone date
function getNewYorkDate() {
    const nyDateStr = getNewYorkDateStr();
    const [year, month, day] = nyDateStr.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}
// Calculate inclusive prorated rent for the 1st month based on NY calendar days
function calculateProratedFirstMonthRent(monthlyRent, startDateUTC) {
    const year = startDateUTC.getUTCFullYear();
    const month = startDateUTC.getUTCMonth();
    const day = startDateUTC.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const remainingDays = Math.max(1, daysInMonth - day + 1);
    const isProrated = day > 1;
    const amount = isProrated
        ? Math.round((monthlyRent / daysInMonth) * remainingDays * 100) / 100
        : monthlyRent;
    return { amount, isProrated, daysInMonth, remainingDays };
}
// Calculate inclusive prorated rent for the last month (1st through endDay, or startDay through endDay if same month)
function calculateProratedLastMonthRent(monthlyRent, endDateUTC, sameMonthStartUTC) {
    const year = endDateUTC.getUTCFullYear();
    const month = endDateUTC.getUTCMonth();
    const endDay = endDateUTC.getUTCDate();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const startDay = sameMonthStartUTC ? sameMonthStartUTC.getUTCDate() : 1;
    const remainingDays = Math.max(1, endDay - startDay + 1);
    const isProrated = remainingDays < daysInMonth;
    const amount = isProrated
        ? Math.round((monthlyRent / daysInMonth) * remainingDays * 100) / 100
        : monthlyRent;
    return { amount, isProrated, daysInMonth, remainingDays };
}
// Helper function to parse YYYY-MM-DD string into midnight UTC Date
function parseDateUTC(dateStr) {
    if (!dateStr)
        return null;
    const cleanStr = dateStr.split('T')[0].trim().replace(/\//g, '-');
    const parts = cleanStr.split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN))
        return null;
    let year = parts[0];
    let month = parts[1];
    let day = parts[2];
    if (parts[2] > 1000) {
        year = parts[2];
        day = parts[0];
        month = parts[1];
    }
    return new Date(Date.UTC(year, month - 1, day));
}
async function generateAutoInvoices() {
    try {
        const today = getNewYorkDate();
        // Fetch active leases that have already started
        const activeLeases = await database_1.default.lease.findMany({
            where: {
                status: 'Active',
                tenant: {
                    status: { not: 'Inactive' },
                },
                property: {
                    status: { notIn: ['Deleted', 'Inactive'] },
                },
            },
            include: {
                tenant: true,
                property: true,
                unit: true,
                renewal: true,
                moveOut: true,
            },
        });
        for (const lease of activeLeases) {
            if (!lease.tenantId || !lease.startDate)
                continue;
            const rawInvoiceStartStr = lease.tenant?.invoiceStartDate;
            const parsedInvoiceStart = rawInvoiceStartStr ? parseDateUTC(rawInvoiceStartStr) : null;
            const start = (parsedInvoiceStart && !isNaN(parsedInvoiceStart.getTime()))
                ? parsedInvoiceStart
                : parseDateUTC(lease.startDate.toISOString());
            if (!start || start > today)
                continue;
            let end = lease.endDate ? parseDateUTC(lease.endDate.toISOString()) : new Date(Date.UTC(2099, 11, 31));
            if (!end)
                continue;
            // If an active MoveOut is scheduled earlier than lease.endDate, stop & prorate at moveOut.scheduledDate
            if (lease.moveOut && lease.moveOut.status !== 'CANCELLED' && lease.moveOut.scheduledDate) {
                const moveOutEnd = parseDateUTC(lease.moveOut.scheduledDate.toISOString());
                if (moveOutEnd && moveOutEnd < end) {
                    end = moveOutEnd;
                }
            }
            // Option A: If renewal was accepted for this lease, tenant continues into next lease without end-month proration
            const isRenewalAccepted = lease.renewal?.status === 'ACCEPTED';
            const endYearMonth = end.toISOString().slice(0, 7);
            // Verify today is not past lease end date
            const limitDate = today < end ? today : end;
            // Batch fetch existing rent invoices for this tenant to avoid connection pool exhaustion
            const existingInvoices = await database_1.default.invoice.findMany({
                where: {
                    tenantId: lease.tenantId,
                    lineItems: {
                        contains: 'Rent',
                    },
                },
                select: {
                    dueDate: true,
                },
            });
            // Deduplicate by YYYY-MM so a month never gets two rent invoices (e.g. 1st vs 10th/15th)
            const existingYearMonths = new Set(existingInvoices
                .map((i) => String(i.dueDate || '').slice(0, 7))
                .filter(Boolean));
            let elapsedMonths = 0;
            let currentBillingDate = new Date(start.getTime());
            while (currentBillingDate <= limitDate) {
                const billingDateStr = currentBillingDate.toISOString().split('T')[0];
                const billingYearMonth = billingDateStr.slice(0, 7);
                if (!existingYearMonths.has(billingYearMonth)) {
                    const tenantName = lease.tenant ? `${lease.tenant.firstName || ''} ${lease.tenant.lastName || ''}`.trim() : 'Tenant';
                    const isFirstMonth = elapsedMonths === 0;
                    const isLastMonth = !isRenewalAccepted && billingYearMonth === endYearMonth;
                    const proration = isFirstMonth && isLastMonth
                        ? calculateProratedLastMonthRent(lease.rentAmount, end, start)
                        : isFirstMonth
                            ? calculateProratedFirstMonthRent(lease.rentAmount, start)
                            : isLastMonth
                                ? calculateProratedLastMonthRent(lease.rentAmount, end)
                                : { amount: lease.rentAmount, isProrated: false, daysInMonth: 0, remainingDays: 0 };
                    const invoiceAmount = proration.amount;
                    const lineItems = [
                        {
                            description: proration.isProrated
                                ? `Prorated Rent Charge (${proration.remainingDays}/${proration.daysInMonth} days)`
                                : 'Rent Charge',
                            amount: invoiceAmount,
                        },
                    ];
                    const createdInvoice = await database_1.default.invoice.create({
                        data: {
                            tenantId: lease.tenantId,
                            tenantName,
                            propertyId: lease.propertyId,
                            propertyName: lease.property?.name || 'Property',
                            unitNumber: lease.unit?.unitNumber || 'Unit',
                            dueDate: billingDateStr,
                            amount: invoiceAmount,
                            balance: invoiceAmount,
                            paidAmount: 0,
                            status: 'Sent',
                            lineItems: JSON.stringify(lineItems),
                            notes: proration.isProrated
                                ? `Auto-generated prorated rent invoice for ${billingDateStr} (${proration.remainingDays}/${proration.daysInMonth} days)`
                                : `Auto-generated rent invoice for billing cycle starting ${billingDateStr}`,
                            companyId: lease.companyId,
                        },
                    });
                    existingYearMonths.add(billingYearMonth);
                    console.log(`[Auto-Billing (NY)] Created invoice for ${tenantName} for cycle date ${billingDateStr} (amount: $${invoiceAmount})`);
                    if (lease.companyId && createdInvoice.tenantId) {
                        email_service_1.emailService.sendInvoiceGeneratedEmail(lease.companyId, createdInvoice).catch((err) => {
                            console.error('[Auto-Billing Invoice Email Trigger] Error:', err);
                        });
                    }
                }
                // Advance to the 1st of the next billing cycle month (2nd month onwards is always 1st of month)
                elapsedMonths++;
                currentBillingDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + elapsedMonths, 1));
            }
        }
    }
    catch (error) {
        console.error('[Auto-Billing (NY)] Error generating auto rent invoices:', error);
    }
}
async function generateAutoLateFees() {
    try {
        const today = getNewYorkDate();
        const todayStr = today.toISOString().split('T')[0];
        // Pre-fetch company late fee settings
        const companies = await database_1.default.company.findMany();
        const companySettingsMap = new Map();
        companies.forEach((c) => {
            companySettingsMap.set(c.id, {
                graceDays: c.lateFeeGraceDays ?? 10,
                feeAmount: c.lateFeeAmount ?? 50,
                feeType: c.lateFeeType || 'FLAT',
                enabled: c.isLateFeeEnabled ?? true,
            });
        });
        // Find all invoices with an unpaid balance and include tenant & unit
        const unpaidInvoices = await database_1.default.invoice.findMany({
            where: {
                balance: { gt: 0 },
                status: { notIn: ['Paid', 'Cancelled'] },
                tenant: {
                    status: { not: 'Inactive' },
                },
            },
            include: {
                tenant: {
                    include: {
                        unit: true,
                    },
                },
            },
        });
        for (const inv of unpaidInvoices) {
            if (!inv.dueDate)
                continue;
            const companyConfig = (inv.companyId && companySettingsMap.get(inv.companyId)) || {
                graceDays: 10,
                feeAmount: 50,
                feeType: 'FLAT',
                enabled: true,
            };
            // Resolve unit-wise late fee policy:
            let unit = inv.tenant?.unit;
            if (!unit && inv.propertyId && inv.unitNumber) {
                unit = await database_1.default.unit.findFirst({
                    where: {
                        propertyId: inv.propertyId,
                        unitNumber: inv.unitNumber,
                    },
                });
            }
            let policy = { ...companyConfig };
            if (unit) {
                if (unit.isLateFeeEnabled === true) {
                    policy = {
                        enabled: true,
                        graceDays: unit.lateFeeGraceDays ?? companyConfig.graceDays,
                        feeAmount: unit.lateFeeAmount ?? companyConfig.feeAmount,
                        feeType: unit.lateFeeType || companyConfig.feeType,
                    };
                }
                else if (unit.isLateFeeEnabled === false) {
                    // Explicitly disabled for this unit
                    policy.enabled = false;
                }
            }
            if (!policy.enabled)
                continue;
            // Ensure it is a rent-related invoice
            const lineItemsStr = String(inv.lineItems || '').toLowerCase();
            if (!lineItemsStr.includes('rent'))
                continue;
            if (lineItemsStr.includes('late fee'))
                continue;
            const due = parseDateUTC(inv.dueDate);
            if (!due)
                continue;
            // Calculate difference in full calendar days (New York Time)
            const diffTime = today.getTime() - due.getTime();
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            // Dynamic grace period check
            if (diffDays >= policy.graceDays) {
                // Mark original invoice as Overdue if status is 'Sent', 'Draft', or 'Pending'
                if (inv.status === 'Sent' || inv.status === 'Draft' || inv.status === 'Pending') {
                    await database_1.default.invoice.update({
                        where: { id: inv.id },
                        data: { status: 'Overdue' },
                    });
                }
                // Check if a Late Fee invoice has already been issued for this specific rent invoice
                const existingLateFee = await database_1.default.invoice.findFirst({
                    where: {
                        tenantId: inv.tenantId,
                        lineItems: {
                            contains: 'Late Fee Charge',
                        },
                        OR: [
                            { notes: { contains: inv.id } },
                            { notes: { contains: inv.dueDate } },
                        ],
                    },
                });
                if (!existingLateFee) {
                    let feeVal = policy.feeAmount;
                    if (policy.feeType === 'PERCENTAGE') {
                        feeVal = Math.round((Number(inv.amount || 0) * (policy.feeAmount / 100)) * 100) / 100;
                    }
                    const lineItems = [
                        { description: `Late Fee Charge (${policy.graceDays}-Day Grace Period Exceeded)`, amount: feeVal },
                    ];
                    await database_1.default.invoice.create({
                        data: {
                            tenantId: inv.tenantId,
                            tenantName: inv.tenantName,
                            propertyId: inv.propertyId,
                            propertyName: inv.propertyName,
                            unitNumber: inv.unitNumber,
                            dueDate: todayStr,
                            amount: feeVal,
                            balance: feeVal,
                            paidAmount: 0,
                            status: 'Sent',
                            lineItems: JSON.stringify(lineItems),
                            notes: `Automated $${feeVal} late fee applied after ${policy.graceDays}-day grace period for rent due on ${inv.dueDate} [Ref: ${inv.id}]`,
                            companyId: inv.companyId,
                        },
                    });
                    console.log(`[Auto-Billing (NY)] Applied $${feeVal} Late Fee after ${policy.graceDays} days for tenant ${inv.tenantName} for overdue rent invoice ${inv.id} due on ${inv.dueDate}`);
                }
            }
        }
    }
    catch (error) {
        console.error('[Auto-Billing (NY)] Error generating auto late fees:', error);
    }
}
