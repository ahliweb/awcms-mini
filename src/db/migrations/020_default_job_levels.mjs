const DEFAULT_JOB_LEVELS = [
  {
    id: "job_level_executive",
    code: "executive",
    name: "Executive",
    rank_order: 10,
    description: "Top-level executive authority and strategic accountability.",
    is_system: true,
  },
  {
    id: "job_level_director",
    code: "director",
    name: "Director",
    rank_order: 9,
    description: "Organization-wide or division-wide leadership responsibility.",
    is_system: true,
  },
  {
    id: "job_level_head",
    code: "head",
    name: "Head",
    rank_order: 8,
    description: "Department or major functional-area leadership.",
    is_system: true,
  },
  {
    id: "job_level_manager",
    code: "manager",
    name: "Manager",
    rank_order: 7,
    description: "Operational management and team oversight.",
    is_system: true,
  },
  {
    id: "job_level_lead",
    code: "lead",
    name: "Lead",
    rank_order: 6,
    description: "Senior specialist or team lead with delivery ownership.",
    is_system: true,
  },
  {
    id: "job_level_supervisor",
    code: "supervisor",
    name: "Supervisor",
    rank_order: 5,
    description: "Front-line supervision and execution monitoring.",
    is_system: true,
  },
  {
    id: "job_level_coordinator",
    code: "coordinator",
    name: "Coordinator",
    rank_order: 4,
    description: "Cross-team coordination and process support.",
    is_system: true,
  },
  {
    id: "job_level_senior_staff",
    code: "senior_staff",
    name: "Senior Staff",
    rank_order: 3,
    description: "Experienced individual contributor with advanced responsibilities.",
    is_system: true,
  },
  {
    id: "job_level_staff",
    code: "staff",
    name: "Staff",
    rank_order: 2,
    description: "Standard individual contributor level.",
    is_system: true,
  },
  {
    id: "job_level_associate",
    code: "associate",
    name: "Associate",
    rank_order: 1,
    description: "Entry-level or junior organizational contributor.",
    is_system: true,
  },
];

export async function up(db) {
  await db.insertInto("job_levels").values(DEFAULT_JOB_LEVELS).execute();
}

export async function down(db) {
  await db.deleteFrom("job_levels").where("id", "in", DEFAULT_JOB_LEVELS.map((level) => level.id)).execute();
}

export { DEFAULT_JOB_LEVELS };
