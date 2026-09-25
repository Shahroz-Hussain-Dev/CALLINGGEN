'use strict';
/** JSON schema for the submit_leads tool (strict). Every property is required; use null when unknown. */

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const stringArray = { type: 'array', items: { type: 'string' } };
const VERIFICATION = ['verified', 'estimated', 'unknown'];

function personSchema(extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'designation', 'source_url', ...Object.keys(extra)],
    properties: {
      name: { type: 'string', description: 'Only a name that is published on a public source. Never invent names.' },
      designation: nullableString,
      source_url: { ...nullableString, description: 'URL where this person is named.' },
      ...extra,
    },
  };
}

const leadProperties = {
  business_name: { type: 'string', description: 'The exact business name as publicly listed.' },
  niche: { type: 'string', description: 'The niche this business belongs to (from the requested niches).' },
  city: { type: 'string', description: 'City in Pakistan where the business operates.' },
  address: { ...nullableString, description: 'Public address if found; else null.' },
  phone: { ...nullableString, description: 'Phone number exactly as seen on a public source. null if not seen. NEVER invent or guess digits.' },
  whatsapp: { ...nullableString, description: 'WhatsApp number exactly as seen on a public source; null if not seen.' },
  public_email: { ...nullableString, description: 'Public email exactly as seen; null if not seen.' },
  website: { ...nullableString, description: 'Official website URL only. Social media pages, Google Maps and directory listings are NOT websites. null if none.' },
  website_status: { type: 'string', enum: ['no_website', 'has_website', 'unknown'], description: 'no_website only when you checked and found no official site.' },
  online_booking_status: { type: 'string', enum: ['none', 'partial', 'full', 'unknown'], description: 'Whether customers can book online through the business\'s own system.' },
  social_profiles: {
    type: 'object', additionalProperties: false,
    required: ['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'other'],
    properties: { instagram: nullableString, facebook: nullableString, tiktok: nullableString, linkedin: nullableString, youtube: nullableString, other: nullableString },
    description: 'Full profile URLs seen on sources; null when not found.',
  },
  business_description: { type: 'string', description: '2-4 sentences describing what the business does, based on sources.' },
  services: stringArray,
  company_size: { type: 'string', enum: ['solo', 'small', 'medium', 'large', 'unknown'] },
  employee_count_estimate: { ...nullableString, description: 'e.g. "5-10" if there is evidence; null otherwise.' },
  business_locations: stringArray,
  departments: { ...stringArray, description: 'Departments only if evident from sources (e.g. sales team, support team); otherwise empty.' },
  owners: { type: 'array', items: personSchema() },
  management: { type: 'array', items: personSchema() },
  decision_makers: { type: 'array', items: personSchema({ contact: { ...nullableString, description: 'Public direct contact for this person if published.' } }) },
  current_booking_method: { ...nullableString, description: 'How customers currently book (phone / WhatsApp / Instagram DM / walk-in), based on evidence.' },
  booking_problems: { ...nullableString, description: 'Any observed booking friction (e.g. "DM to book", "call only", slow replies mentioned in reviews).' },
  website_opportunity: { ...nullableString, description: 'Why a website could help this specific business, or null if no clear reason.' },
  booking_automation_opportunity: { ...nullableString, description: 'Why online booking could help this specific business, or null if no clear reason.' },
  existing_software: stringArray,
  operational_challenges: stringArray,
  repetitive_processes: { ...stringArray, description: 'Specific repetitive workflows observed or reasonably inferred from what the business does.' },
  automation_opportunities: {
    type: 'array',
    items: {
      type: 'object', additionalProperties: false, required: ['process', 'opportunity', 'latechs_service'],
      properties: {
        process: { type: 'string', description: 'The specific business process (e.g. "Answering WhatsApp inquiries about Umrah packages").' },
        opportunity: { type: 'string', description: 'Concrete automation that fits this process.' },
        latechs_service: { type: 'string', description: 'The matching LATechS service name.' },
      },
    },
  },
  relevant_latechs_services: stringArray,
  field_verification: {
    type: 'object', additionalProperties: false,
    required: ['business_name', 'phone', 'website', 'address', 'social_profiles', 'people'],
    properties: {
      business_name: { type: 'string', enum: VERIFICATION }, phone: { type: 'string', enum: VERIFICATION }, website: { type: 'string', enum: VERIFICATION },
      address: { type: 'string', enum: VERIFICATION }, social_profiles: { type: 'string', enum: VERIFICATION }, people: { type: 'string', enum: VERIFICATION },
    },
  },
  source_urls: { ...stringArray, description: 'Every URL you used for this business.' },
  confidence: { type: 'string', enum: ['verified', 'partially_verified', 'estimated', 'needs_verification'] },
  qualification_notes: { type: 'string', description: 'Why this business qualifies for the panel, in 1-3 sentences.' },
};

const SUBMIT_LEADS_TOOL = {
  name: 'submit_leads',
  description: 'Submit the final list of qualified, real businesses. Call this exactly once when research is complete. Submit fewer leads than requested rather than including anything unverified or invented.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['search_notes', 'leads'],
    properties: {
      search_notes: { type: 'string', description: 'What you searched, how many real businesses you could confirm, and why any slots are unfilled.' },
      leads: { type: 'array', items: { type: 'object', additionalProperties: false, required: Object.keys(leadProperties), properties: leadProperties } },
    },
  },
};

/** Non-strict copy used as a fallback if the API rejects the strict schema. */
const SUBMIT_LEADS_TOOL_LOOSE = { ...SUBMIT_LEADS_TOOL, strict: false };

module.exports = { SUBMIT_LEADS_TOOL, SUBMIT_LEADS_TOOL_LOOSE, leadProperties };
