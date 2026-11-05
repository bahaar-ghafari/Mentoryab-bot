// Canonical option values, shared by every locale. These are what gets stored in
// the database and used as callback_data, so they must never be translated —
// only their displayed button label is (see labels.ts). Keeping one shared list
// per option type is what lets a Farsi-onboarded mentor and an English-onboarded
// mentee still match on the same underlying skill/title/country value.

export const SKILL_OPTIONS = [
  'Product management',
  'Software engineering',
  'Data science',
  'Design',
  'AI / ML',
  'Career coaching',
  'Leadership',
  'Marketing',
  'Finance',
  'Other',
];

export const TITLE_OPTIONS = [
  'Frontend Engineer',
  'Backend Engineer',
  'Full Stack Engineer',
  'Mobile Engineer',
  'Data Scientist',
  'ML Engineer',
  'DevOps Engineer',
  'Product Manager',
  'UX/UI Designer',
  'Engineering Manager',
  'CTO / VP Engineering',
  'Career Coach',
];

export const COUNTRY_OPTIONS = [
  'Iran',
  'United States',
  'United Kingdom',
  'Canada',
  'Australia',
  'Germany',
  'France',
  'Netherlands',
  'Sweden',
  'UAE',
  'Turkey',
  'India',
  'Pakistan',
  'Other',
];

// Main technical stack a mentor works in. Used only to decide which
// language/framework/tool suggestions to show on the next onboarding step —
// it isn't persisted on the profile.
export const STACK_OPTIONS = [
  'Frontend',
  'Backend',
  'Full Stack',
  'Mobile',
  'Data / AI / ML',
  'DevOps / Cloud',
  'QA / Testing',
  'Security',
  'Game Development',
  'Embedded / Systems',
  'UX/UI Design',
  'Product / Management',
  'Other',
];

const GENERAL_TECH = [
  'Python', 'JavaScript', 'TypeScript', 'Java', 'C#', 'C++', 'Go', 'Rust', 'PHP', 'SQL',
  'Git', 'Docker', 'Linux', 'AWS', 'System Design', 'Algorithms',
];

// Suggested languages, frameworks and tools per stack. These are canonical
// (never translated) — tech names are written the same in every locale. Mentors
// can still type anything not listed.
export const TECH_SUGGESTIONS: Record<string, string[]> = {
  Frontend: [
    'JavaScript', 'TypeScript', 'HTML', 'CSS', 'React', 'Next.js', 'Vue.js', 'Nuxt', 'Angular', 'Svelte',
    'Tailwind CSS', 'Sass', 'Redux', 'Vite', 'Webpack', 'Jest', 'Cypress', 'Storybook', 'GraphQL',
    'Web Performance', 'Accessibility',
  ],
  Backend: [
    'Python', 'Java', 'Node.js', 'TypeScript', 'Go', 'C#', 'PHP', 'Ruby', 'Rust', 'Kotlin',
    'Django', 'FastAPI', 'Flask', 'Spring Boot', 'NestJS', 'Express', 'Laravel', 'Ruby on Rails', 'ASP.NET Core',
    'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Kafka', 'RabbitMQ',
    'REST APIs', 'GraphQL', 'gRPC', 'Microservices', 'System Design',
  ],
  'Full Stack': [
    'JavaScript', 'TypeScript', 'Python', 'Node.js', 'PHP', 'React', 'Next.js', 'Vue.js', 'Angular',
    'Django', 'Laravel', 'NestJS', 'Express', 'PostgreSQL', 'MongoDB', 'Redis', 'Docker', 'GraphQL', 'REST APIs',
  ],
  Mobile: [
    'Swift', 'SwiftUI', 'Objective-C', 'Kotlin', 'Java', 'Jetpack Compose', 'Dart', 'Flutter', 'React Native',
    'Android SDK', 'iOS SDK', '.NET MAUI', 'Firebase', 'Mobile CI/CD', 'App Store Release',
  ],
  'Data / AI / ML': [
    'Python', 'R', 'SQL', 'Scala', 'Pandas', 'NumPy', 'Scikit-learn', 'TensorFlow', 'PyTorch', 'Keras',
    'Spark', 'Airflow', 'dbt', 'Hugging Face', 'LangChain', 'LLMs', 'NLP', 'Computer Vision', 'MLOps',
    'Data Engineering', 'Tableau', 'Power BI',
  ],
  'DevOps / Cloud': [
    'Linux', 'Bash', 'Python', 'Go', 'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Helm',
    'AWS', 'GCP', 'Azure', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'Prometheus', 'Grafana', 'Nginx', 'SRE',
  ],
  'QA / Testing': [
    'Test Automation', 'Manual Testing', 'Selenium', 'Cypress', 'Playwright', 'Appium', 'Jest', 'JUnit', 'pytest',
    'Postman', 'k6', 'JMeter', 'TDD', 'BDD', 'Python', 'Java', 'JavaScript',
  ],
  Security: [
    'Penetration Testing', 'OWASP', 'Burp Suite', 'Network Security', 'Cryptography', 'Threat Modeling',
    'SIEM', 'Incident Response', 'Cloud Security', 'Malware Analysis', 'Linux', 'Python',
  ],
  'Game Development': [
    'Unity', 'Unreal Engine', 'Godot', 'C#', 'C++', 'Blender', 'Game Design', 'Shaders', 'Multiplayer',
  ],
  'Embedded / Systems': [
    'C', 'C++', 'Rust', 'Assembly', 'RTOS', 'Arduino', 'Raspberry Pi', 'ESP32', 'Linux Kernel', 'FPGA', 'Python',
  ],
  'UX/UI Design': [
    'Figma', 'Sketch', 'Adobe XD', 'Photoshop', 'Illustrator', 'Framer', 'Webflow', 'Design Systems',
    'Prototyping', 'Wireframing', 'User Research', 'Usability Testing', 'Accessibility',
  ],
  'Product / Management': [
    'Agile', 'Scrum', 'Kanban', 'Jira', 'Roadmapping', 'OKRs', 'User Stories', 'Product Discovery',
    'Analytics', 'A/B Testing', 'Stakeholder Management', 'Hiring', 'Team Leadership', 'Career Growth',
  ],
  Other: GENERAL_TECH,
};
