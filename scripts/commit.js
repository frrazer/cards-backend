#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const { execSync } = require('child_process');

// Get arguments from command line
const args = process.argv.slice(2);

if (args.length < 2) {
    console.error('Usage: npm run commit <branch> "<commit message>"');
    console.error('Example: npm run commit dev "Add new feature"');
    process.exit(1);
}

const branch = 'main';
const commitMessage = args.slice(1).join(' ');

const commands = [
    { cmd: 'npm run generate:template', description: 'Generating template...' },
    { cmd: 'npx prettier --write "src/**/*.{ts,js,json}"', description: 'Formatting with Prettier...' },
    { cmd: 'npx eslint . --fix', description: 'Running ESLint...' },
    { cmd: 'git add .', description: 'Staging changes...' },
    { cmd: `git commit -m "${commitMessage}"`, description: 'Committing changes...' },
    { cmd: `git push origin ${branch}`, description: `Pushing to ${branch}...` },
];

console.log('\n🚀 Starting commit process...\n');

for (const { cmd, description } of commands) {
    try {
        console.log(`⏳ ${description}`);
        execSync(cmd, { stdio: 'inherit' });
        console.log(`✅ ${description.replace('...', '')} completed\n`);
    } catch (error) {
        console.error(`\n❌ Error during: ${description}`);
        console.error(`Command failed: ${cmd}`);
        process.exit(1);
    }
}

console.log('✨ All done! Changes committed and pushed successfully.\n');
