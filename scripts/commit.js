#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

const { execSync } = require('child_process');

const args = process.argv.slice(2);

if (args.length < 2) {
    console.error('Usage: npm run commit <branch> "<commit message>"');
    console.error('Example: npm run commit dev "Add new feature"');
    process.exit(1);
}

const branch = 'main';
const commitMessage = args.slice(1).join(' ');

const run = (cmd, description) => {
    console.log(`⏳ ${description}`);
    execSync(cmd, { stdio: 'inherit' });
    console.log(`✅ ${description.replace('...', '')} completed\n`);
};

const hasChangesToCommit = () => {
    try {
        execSync('git diff --cached --quiet');
        return false;
    } catch {
        return true;
    }
};

console.log('\n🚀 Starting commit process...\n');

try {
    run('npm run generate:template', 'Generating template...');
    run('npx prettier --write "src/**/*.{ts,js,json}"', 'Formatting with Prettier...');
    run('npx eslint . --fix', 'Running ESLint...');
    run('git add .', 'Staging changes...');

    if (!hasChangesToCommit()) {
        console.log('ℹ️  No changes to commit - working tree is clean.\n');
        console.log('✨ All done! Nothing new to commit.\n');
        process.exit(0);
    }

    run(`git commit -m "${commitMessage}"`, 'Committing changes...');
    run(`git push origin ${branch}`, `Pushing to ${branch}...`);

    console.log('✨ All done! Changes committed and pushed successfully.\n');
} catch (error) {
    console.error(`\n❌ Error: ${error.message}`);
    process.exit(1);
}
