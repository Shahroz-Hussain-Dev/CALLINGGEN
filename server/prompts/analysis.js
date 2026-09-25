'use strict';
/** Prompts + schemas for meeting preparation, automation analysis and booking-need analysis. */
const { LATECHS_SERVICES } = require('./leadGeneration');

const stringArray = { type: 'array', items: { type: 'string' } };

const BUSINESS_PROFILE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['business_name', 'summary', 'services', 'team_size_estimate', 'departments', 'management_structure', 'operational_processes',
    'customer_process', 'sales_process', 'repetitive_tasks', 'automation_opportunities', 'relevant_latechs_services', 'discovery_questions',
    'talking_points', 'proposal_outline', 'risks_and_objections', 'data_confidence', 'sources_used'],
  properties: {
    business_name: { type: 'string' },
    summary: { type: 'string', description: '3-5 sentence overview of the business based on available information.' },
    services: stringArray,
    team_size_estimate: { type: 'string', description: 'e.g. "10-20 staff (estimated from job posts and branch count)". Say "unknown" if no evidence.' },
    departments: stringArray,
    management_structure: { type: 'string', description: 'Only publicly known people/roles. Say what is unknown.' },
    operational_processes: stringArray,
    customer_process: { type: 'string', description: 'How a customer typically interacts with this business end-to-end.' },
    sales_process: { type: 'string' },
    repetitive_tasks: stringArray,
    automation_opportunities: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['process', 'current_way', 'proposed_automation', 'latechs_service', 'expected_benefit'],
        properties: {
          process: { type: 'string' }, current_way: { type: 'string' }, proposed_automation: { type: 'string' },
          latechs_service: { type: 'string' }, expected_benefit: { type: 'string' },
        },
      },
    },
    relevant_latechs_services: stringArray,
    discovery_questions: { ...stringArray, description: 'Questions to ask in the meeting to confirm assumptions.' },
    talking_points: stringArray,
    proposal_outline: { type: 'string', description: 'A customized proposal outline the employee can present, in plain language.' },
    risks_and_objections: stringArray,
    data_confidence: { type: 'string', enum: ['verified', 'partially_verified', 'estimated', 'needs_verification'] },
    sources_used: stringArray,
  },
};

const BOOKING_ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'current_booking_process', 'problems_identified', 'customer_inconvenience', 'business_inconvenience', 'website_requirement',
    'booking_system_requirement', 'recommended_solution', 'talking_points', 'inquiry_questions', 'introduction_script', 'do_not_assume', 'data_confidence'],
  properties: {
    summary: { type: 'string' },
    current_booking_process: { type: 'string' },
    problems_identified: stringArray,
    customer_inconvenience: stringArray,
    business_inconvenience: stringArray,
    website_requirement: { type: 'string', description: 'Whether a website is genuinely needed and why, or "no clear requirement".' },
    booking_system_requirement: { type: 'string', description: 'Whether an online booking system is genuinely needed and why, or "no clear requirement".' },
    recommended_solution: { type: 'string' },
    talking_points: stringArray,
    inquiry_questions: { ...stringArray, description: 'Customer-style questions to ask first (before introducing LATechS).' },
    introduction_script: { type: 'string', description: 'Short, natural way to introduce LATechS only after the booking process is understood.' },
    do_not_assume: { ...stringArray, description: 'Things that are NOT yet known and must not be assumed.' },
    data_confidence: { type: 'string', enum: ['verified', 'partially_verified', 'estimated', 'needs_verification'] },
  },
};

const PROFILE_SYSTEM = `You prepare sales meeting research for LATechS, a Pakistani automation and web company. Given a business record and its call history, produce a specific, honest business profile and a customized automation proposal outline.
Rules: never invent people, numbers, software names or facts; clearly separate what is known from what is estimated; ground every automation opportunity in a specific process the business actually runs; keep language plain and practical for a sales employee in Pakistan. LATechS services: ${LATECHS_SERVICES.join(', ')}. If web search is available, use it to confirm details and cite sources; otherwise state that details are unverified.`;

const BOOKING_SYSTEM = `You help a LATechS sales employee understand a Pakistani appointment-based business's booking process before introducing LATechS (websites, online booking systems, appointment systems, booking automation).
Rules: base the analysis only on the record and call notes provided; do not assume the business needs a website; list open questions; keep the initial inquiry stage separate from the LATechS introduction; be concrete and practical.`;

function contactContext(contact, calls, research) {
  const c = { ...contact };
  delete c.id; delete c.current_owner_id; delete c.original_owner_id; delete c.contact_list_id; delete c.generation_job_id;
  const callText = (calls || []).map((r) => `- ${new Date(r.call_datetime).toISOString().slice(0, 16)} | ${r.employee_name || ''} | status: ${r.call_status} | spoke to: ${r.person_contacted || '-'} (${r.person_designation || '-'})\n  summary: ${r.conversation_summary || '-'}\n  customer response: ${r.customer_response || '-'}\n  problems: ${r.problems_identified || '-'} | objections: ${r.objections || '-'}\n  panel fields: ${JSON.stringify(r.panel_fields || {})}`).join('\n');
  const prev = research ? `\nPREVIOUS RESEARCH (for reference):\n${JSON.stringify(research).slice(0, 4000)}` : '';
  return `BUSINESS RECORD:\n${JSON.stringify(c, null, 1).slice(0, 12000)}\n\nCALL HISTORY (chronological):\n${callText || '(no calls yet)'}${prev}`;
}

module.exports = { BUSINESS_PROFILE_SCHEMA, BOOKING_ANALYSIS_SCHEMA, PROFILE_SYSTEM, BOOKING_SYSTEM, contactContext };
