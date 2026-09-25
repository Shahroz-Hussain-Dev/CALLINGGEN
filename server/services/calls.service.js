'use strict';
const db = require('../db');
const { ValidationError } = require('../lib/errors');
const v = require('../lib/validate');
const activity = require('./activity.service');
const cycle = require('./cycle.service');
const contacts = require('./contacts.service');

const STRATEGY_FIELDS = {
  asked_about_online_booking: 'bool', has_website: 'tri', current_booking_method: 'str', offers_online_appointments: 'tri',
  latechs_introduced: 'bool', website_development_discussed: 'bool', interested_in_website: 'tri', interested_in_booking_system: 'tri',
};
const SERVICE_FIELDS = {
  business_contacted: 'bool', decision_maker_reached: 'bool', decision_maker_name: 'str', decision_maker_designation: 'str',
  meeting_requested: 'bool', meeting_booked: 'bool', automation_opportunities_discussed: 'str', services_interested: 'str', meeting_outcome: 'str',
};
const CONVERSATION_STATUSES = ['interested', 'not_interested', 'call_back_later', 'meeting_booked', 'follow_up_required', 'business_closed'];

function tri(value, field) {
  if (value === undefined || value === null || value === '' || value === 'unknown') return null;
  return v.bool(value, { field });
}

function validatePanelFields(panel, raw) {
  const spec = panel === 'strategy' ? STRATEGY_FIELDS : SERVICE_FIELDS;
  const input = v.objectOrEmpty(raw, 'panel_fields');
  const out = {};
  for (const [key, type] of Object.entries(spec)) {
    if (input[key] === undefined) continue;
    if (type === 'bool') out[key] = v.bool(input[key], { field: key });
    else if (type === 'tri') out[key] = tri(input[key], key);
    else out[key] = v.str(input[key], { field: key, max: 2000 });
  }
  return out;
}

async function recordCall(user, contactId, payload) {
  const contact = await contacts.getForUser(user, contactId);
  const p = payload || {};
  const callStatus = v.oneOf(p.call_status, contacts.CALL_STATUSES.filter((s) => s !== 'not_called'), { field: 'call_status', required: true });
  const summary = v.str(p.conversation_summary, { field: 'conversation_summary', max: 8000 });
  if (CONVERSATION_STATUSES.includes(callStatus) && !summary) throw new ValidationError('Please record a conversation summary before saving this call');
  const interest = v.oneOf(p.interest_level, contacts.INTEREST_LEVELS, { field: 'interest_level' });
  const followUpRequired = v.bool(p.follow_up_required, { field: 'follow_up_required' }) || callStatus === 'follow_up_required' || callStatus === 'call_back_later';
  const nextFollowUp = v.dateStr(p.next_follow_up_date, { field: 'next_follow_up_date' });
  if (followUpRequired && !nextFollowUp) throw new ValidationError('A follow-up date is required when a follow-up is needed');
  const meetingRequired = v.bool(p.meeting_required, { field: 'meeting_required' }) || callStatus === 'meeting_booked' || interest === 'meeting_requested' || interest === 'meeting_booked';
  const panelFields = validatePanelFields(contact.contact_type, p.panel_fields);
  const callDatetime = p.call_datetime ? new Date(p.call_datetime) : new Date();
  if (Number.isNaN(callDatetime.getTime())) throw new ValidationError('call_datetime is invalid');
  const fields = {
    person_contacted: v.str(p.person_contacted, { field: 'person_contacted', max: 200 }),
    person_designation: v.str(p.person_designation, { field: 'person_designation', max: 200 }),
    customer_response: v.str(p.customer_response, { field: 'customer_response', max: 8000 }),
    services_discussed: v.str(p.services_discussed, { field: 'services_discussed', max: 2000 }),
    problems_identified: v.str(p.problems_identified, { field: 'problems_identified', max: 4000 }),
    objections: v.str(p.objections, { field: 'objections', max: 4000 }),
    additional_notes: v.str(p.additional_notes, { field: 'additional_notes', max: 8000 }),
  };

  const state = await cycle.getState();
  let record;
  let followUp = null;
  await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO call_records (contact_id, employee_id, list_id, call_datetime, person_contacted, person_designation, call_status, conversation_summary, customer_response,
         interest_level, services_discussed, problems_identified, objections, follow_up_required, next_follow_up_date, meeting_required, additional_notes, panel_fields, cycle_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [contact.id, user.id, contact.contact_list_id, callDatetime, fields.person_contacted, fields.person_designation, callStatus, summary, fields.customer_response,
        interest, fields.services_discussed, fields.problems_identified, fields.objections, followUpRequired, nextFollowUp, meetingRequired, fields.additional_notes, JSON.stringify(panelFields), state.current_cycle_number],
    );
    record = rows[0];

    // ---- contact updates ----------------------------------------------------
    let meetingStatus = contact.meeting_status;
    if (callStatus === 'meeting_booked' || interest === 'meeting_booked' || panelFields.meeting_booked) meetingStatus = 'booked';
    else if ((meetingRequired || panelFields.meeting_requested) && meetingStatus === 'none') meetingStatus = 'requested';

    const ops = { ...(contact.business_operations || {}) };
    let websiteAvailable = contact.website_available;
    const decisionMakers = Array.isArray(contact.decision_makers) ? [...contact.decision_makers] : [];
    if (contact.contact_type === 'strategy') {
      if (panelFields.current_booking_method) ops.current_booking_method = panelFields.current_booking_method;
      if (panelFields.has_website !== undefined && panelFields.has_website !== null) { websiteAvailable = panelFields.has_website; ops.website_status = panelFields.has_website ? 'has_website' : 'no_website'; }
      if (panelFields.offers_online_appointments !== undefined && panelFields.offers_online_appointments !== null) ops.online_booking_status = panelFields.offers_online_appointments ? 'full' : 'none';
      if (panelFields.interested_in_website !== undefined) ops.interested_in_website = panelFields.interested_in_website;
      if (panelFields.interested_in_booking_system !== undefined) ops.interested_in_booking_system = panelFields.interested_in_booking_system;
      if (panelFields.latechs_introduced) ops.latechs_introduced = true;
      if (fields.problems_identified) ops.booking_problems_reported = fields.problems_identified;
    } else {
      if (panelFields.decision_maker_name) {
        const name = panelFields.decision_maker_name.trim();
        if (!decisionMakers.some((d) => d && String(d.name).toLowerCase() === name.toLowerCase())) {
          decisionMakers.push({ name, designation: panelFields.decision_maker_designation || fields.person_designation || null, source: 'call', recorded_by: user.display_name, recorded_at: new Date().toISOString() });
        }
      }
      if (panelFields.automation_opportunities_discussed) ops.automation_opportunities_discussed = panelFields.automation_opportunities_discussed;
      if (panelFields.services_interested) ops.services_interested = panelFields.services_interested;
      if (panelFields.meeting_outcome) ops.last_meeting_outcome = panelFields.meeting_outcome;
    }

    await client.query(
      `UPDATE contacts SET contact_status = $2, interest_level = COALESCE($3, interest_level), last_call_at = $4, call_count = call_count + 1, processed_cycle = $5,
         last_processed_at = now(), follow_up_date = CASE WHEN $6::date IS NOT NULL THEN $6::date ELSE follow_up_date END, meeting_status = $7,
         business_operations = $8, website_available = $9, decision_makers = $10, skip_reason = NULL
       WHERE id = $1`,
      [contact.id, callStatus, interest, callDatetime, state.current_cycle_number, nextFollowUp, meetingStatus, JSON.stringify(ops), websiteAvailable, JSON.stringify(decisionMakers)],
    );

    if (followUpRequired && nextFollowUp) {
      const reason = callStatus === 'call_back_later' ? 'Customer asked to call back' : (interest === 'maybe_follow_up' ? 'Customer may be interested - follow up' : 'Follow-up from call');
      const { rows: fu } = await client.query(
        `INSERT INTO follow_ups (contact_id, call_record_id, owner_id, created_by, contact_person, follow_up_date, reason, notes)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7) RETURNING *`,
        [contact.id, record.id, user.id, fields.person_contacted, nextFollowUp, reason, fields.additional_notes || summary],
      );
      followUp = fu[0];
      await activity.log('follow_up_created', { userId: user.id, contactId: contact.id, listId: contact.contact_list_id, details: { follow_up_id: followUp.id, date: nextFollowUp, from_call: true } }, client);
    }
    await activity.log('call_recorded', { userId: user.id, contactId: contact.id, listId: contact.contact_list_id, details: { call_status: callStatus, interest_level: interest, meeting_required: meetingRequired, cycle: state.current_cycle_number } }, client);
  });
  const updated = await contacts.getById(contact.id);
  return { call: record, follow_up: followUp, contact: updated };
}

async function listForContact(user, contactId) {
  const contact = await contacts.getForUser(user, contactId);
  const { rows } = await db.query('SELECT r.*, u.display_name AS employee_name FROM call_records r JOIN users u ON u.id = r.employee_id WHERE r.contact_id = $1 ORDER BY r.call_datetime ASC', [contact.id]);
  return rows;
}

module.exports = { recordCall, listForContact, STRATEGY_FIELDS, SERVICE_FIELDS };
