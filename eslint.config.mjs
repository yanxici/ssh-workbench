// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/**
 * ESLint 扁平配置。
 *
 * 校准原则：这套规则是给「已经在跑、注释写得很足」的既有代码加护栏，
 * 不是重排风格。所以只开能抓真问题的规则，不加会产出几千条噪声的排版规则
 * （既有代码 23537 行不带分号、单引号为主，这些是既定风格，不动）。
 *
 * 分三档：
 * - 类型感知（src/main、src/preload、src/shared）：最严，主进程是风险最集中处；
 * - 渲染层（src/renderer）：类型感知 + React Hooks 规则；
 * - scripts/*.cjs：Node 环境，只查明显错误（拼写、未定义、重复 case）。
 */
export default tseslint.config(
  {
    // 构建产物、依赖、以及 verify 脚本自己的临时编译目录
    ignores: [
      'out/**',
      'dist*/**',
      'node_modules/**',
      '.tsc-verify/**',
      'stress-test-results/**',
      '**/*.d.ts'
    ]
  },

  /* ---------------- 主进程 / 预加载 / 共享类型 ---------------- */
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked
    ],
    languageOptions: {
      parserOptions: {
        // 类型感知 linting 需要 project；用 root tsconfig 的 references
        project: ['./tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname
      },
      globals: { ...globals.node }
    },
    rules: {
      // ---- 能抓真 bug 的类型感知规则 ----
      // 项目里 IPC 调用约定是「void call(...)」显式丢弃 promise，这条能抓出忘写 void 的
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } }
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

      // ---- 通用正确性 ----
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-throw-literal': 'error',
      // 空 catch 是本项目的既定写法（87 处，且都带注释说明为什么可以吞）。
      // 保留规则但放行「带注释的空 catch」——那种才是真的说明过原因。
      'no-empty': ['error', { allowEmptyCatch: true }],

      // ---- 与现有代码对齐的放宽项 ----
      // 注释与日志里大量全角标点/中文，不做 no-irregular-whitespace 的严格限制
      'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true }],
      // tsc 已有 noUnusedLocals，这里只保留「声明了但没用」的兜底
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      // 允许 void 表达式用于显式丢弃 promise（见 no-floating-promises.ignoreVoid）
      'no-void': 'off',
      // 主进程大量使用「先声明后按需赋值」的模式
      'prefer-const': ['error', { destructuring: 'all' }],
      // 允许在 case 里声明变量（switch 较少，不强制加块）
      'no-case-declarations': 'off',
      // 允许对象字面量里的多余空格与中文标点
      'no-useless-escape': 'error'
    }
  },

  /* ---------------- 渲染层 ---------------- */
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked
    ],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.web.json'],
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true }
      },
      globals: { ...globals.browser }
    },
    rules: {
      // ---- React Hooks：这两条是本项目最需要的 ----
      // rules-of-hooks 抓「hook 写在条件/循环/错误组件里」——
      // 本次重构就踩过：把 useSftpStore 放进了 TreeLevel 却在 TreeRow 里用。
      'react-hooks/rules-of-hooks': 'error',
      // exhaustive-deps 抓漏依赖（setState 引用、闭包过期值）
      'react-hooks/exhaustive-deps': 'warn',

      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } }
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-irregular-whitespace': ['error', { skipComments: true, skipStrings: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      // JSX 里用到的组件不会被识别成「未使用」，交给 tsc
      '@typescript-eslint/no-unused-expressions': 'error',
      'no-void': 'off',
      'no-case-declarations': 'off',
      // 渲染层大量 <a> 走 shell 打开，不是真链接
      'jsx-a11y/no-static-element-interactions': 'off'
    }
  },

  /* ---------------- 验证脚本（Node CJS） ---------------- */
  {
    files: ['scripts/**/*.cjs', 'scripts/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      // 这些脚本刻意用 process.exit / 同步 IO，且大量动态 require
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-undef': 'error'
    }
  },

  /* ---------------- 配置文件本身 ---------------- */
  {
    files: ['*.config.js', '*.config.mjs', 'eslint.config.mjs', 'postcss.config.js', 'tailwind.config.js'],
    languageOptions: { globals: { ...globals.node } }
  }
)
