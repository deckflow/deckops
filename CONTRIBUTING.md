# Contributing to Deckflow CLI

Thank you for your interest in contributing to Deckflow CLI! This document provides guidelines and instructions for contributing.

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Git

### Setup Development Environment

```bash
# Clone the repository
git clone <repository-url>
cd nodejs-deckflow-cli

# Install dependencies
npm install

# Build the project
npm run build

# Run tests
npm test
```

## 📝 Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Changes

- Write clean, readable code
- Follow the existing code style
- Add tests for new features
- Update documentation as needed

### 3. Test Your Changes

```bash
# Run all tests
npm test

# Run specific test file
npm test -- tests/unit/your-test.test.ts

# Run with coverage
npm run test:coverage

# Build to ensure no errors
npm run build
```

### 4. Commit Your Changes

We follow conventional commit messages:

```bash
git commit -m "feat: add new feature"
git commit -m "fix: resolve bug in file upload"
git commit -m "docs: update README"
git commit -m "test: add tests for API client"
```

**Commit types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `test`: Adding or updating tests
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `chore`: Maintenance tasks

### 5. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a pull request on GitHub.

## 🧪 Testing Guidelines

### Writing Tests

All new features should include tests:

**Unit Tests** (`tests/unit/`):
```typescript
import { describe, it, expect } from 'vitest';
import { YourModule } from '../../src/your-module.js';

describe('YourModule', () => {
  it('should do something', () => {
    const result = YourModule.doSomething();
    expect(result).toBe(expected);
  });
});
```

**E2E Tests** (`tests/e2e/`):
```typescript
import { runCLI } from './helpers.js';

it('should handle command correctly', async () => {
  const result = await runCLI(['your', 'command']);
  expect(result.exitCode).toBe(0);
});
```

### Test Coverage

Aim for:
- **100% coverage** for core modules (config, api-client, file-uploader)
- **80%+ coverage** for command modules
- **All critical paths** tested in E2E tests

## 📐 Code Style

### TypeScript

- Use TypeScript strict mode
- Define types for all parameters and return values
- Use interfaces for complex types
- Avoid `any` type when possible

### Formatting

We use Prettier for code formatting:

```bash
# Format code
npm run format

# Check formatting
npm run lint
```

**Key rules:**
- 2 spaces for indentation
- Single quotes for strings
- Semicolons required
- 100 character line length

### Naming Conventions

- **Files**: kebab-case (`api-client.ts`, `file-uploader.ts`)
- **Classes**: PascalCase (`APIClient`, `FileUploader`)
- **Functions**: camelCase (`uploadFile`, `getTask`)
- **Constants**: UPPER_SNAKE_CASE (`DEFAULT_TIMEOUT`, `CHUNK_SIZE`)
- **Types/Interfaces**: PascalCase (`Task`, `UploadAuthResponse`)

## 🏗️ Project Structure

```
src/
├── core/           # Core business logic
├── commands/       # CLI command implementations
├── types/          # TypeScript type definitions
├── utils/          # Utility functions
├── context.ts      # Global CLI context
└── cli.ts          # Main entry point

tests/
├── unit/           # Unit tests (match src/ structure)
├── e2e/            # End-to-end tests
└── fixtures/       # Test data
```

## 🐛 Reporting Bugs

When reporting bugs, please include:

1. **Description**: Clear description of the bug
2. **Steps to reproduce**: Numbered steps
3. **Expected behavior**: What should happen
4. **Actual behavior**: What actually happens
5. **Environment**: Node.js version, OS, etc.
6. **Logs**: Any error messages or logs

**Example:**
```markdown
### Bug Description
File upload fails for files > 20MB

### Steps to Reproduce
1. Run `deckflow file upload large-file.mp4`
2. File is 25MB
3. Upload fails with timeout error

### Expected
File should upload successfully

### Actual
Error: "Task did not complete within 300s"

### Environment
- Node.js: 18.0.0
- OS: macOS 14.0
- deckflow: 0.2.0
```

## 💡 Feature Requests

We welcome feature requests! Please:

1. Check existing issues first
2. Describe the use case
3. Explain why it's valuable
4. Suggest implementation if possible

## 📚 Documentation

When contributing, update documentation:

- **README.md**: For user-facing features
- **Code comments**: For complex logic
- **JSDoc**: For public APIs
- **CHANGELOG.md**: For all changes

## ✅ Pull Request Checklist

Before submitting:

- [ ] Code follows style guidelines
- [ ] Tests added and passing
- [ ] Documentation updated
- [ ] Commit messages follow convention
- [ ] No merge conflicts
- [ ] Build succeeds (`npm run build`)
- [ ] All tests pass (`npm test`)

## 🤝 Code Review Process

1. Maintainer reviews your PR
2. Feedback provided (if needed)
3. You address feedback
4. PR approved and merged

**Review criteria:**
- Code quality and style
- Test coverage
- Documentation
- Performance impact
- Breaking changes

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## ❓ Questions?

Feel free to:
- Open an issue for questions
- Join our discussions
- Reach out to maintainers

Thank you for contributing! 🎉
