# caricamento

CLI для сборки, подписи и доставки мобильных релизов. Одна команда —
от исходников до установленной сборки у тестировщиков.

**Статус: MVP** — Android (нативный, React Native CLI, Expo) + Firebase App
Distribution + Google Play. iOS заложена в архитектуру (см. [SPEC.md](SPEC.md)),
но пока не реализована.

## Возможности

- Сборка Android APK/AAB через Gradle (нативные проекты, RN CLI, Expo bare)
- **Zero-touch подпись**: релиз подписывается вашим keystore через
  сгенерированный Gradle init script — файлы проекта не модифицируются и
  переживают `expo prebuild --clean`
- Проверка подписи после сборки (APK — `apksigner verify`, AAB — `jarsigner`/`keytool`;
  в обоих случаях сверка SHA-256 отпечатка)
- Выгрузка в Firebase App Distribution: upload → release notes → рассылка
  группам тестеров (чистый REST, без firebase-tools)
- Публикация в Google Play: AAB → трек (internal/alpha/beta/production) →
  mapping.txt для деобфускации — одной командой (чистый REST, без googleapis)
- Стратегия версионирования `auto-increment`: versionCode = текущий максимум
  в Play + 1
- Автодетекция типа проекта, журнал всех запусков
- Машиночитаемый вывод `--json` и `--dry-run` для CI

## Требования

| Инструмент | Зачем | Проверка |
|---|---|---|
| macOS | основная платформа | — |
| Node.js ≥ 20 | рантайм CLI | `node --version` |
| JDK 17 | сборка Android | `java -version` |
| Android SDK (`ANDROID_HOME`) | build-tools, apksigner | `caricamento doctor` |
| Gradle wrapper в проекте | сборка | `caricamento doctor` |

## Установка

Пока пакет не опубликован в npm — ставим из репозитория:

```bash
git clone git@github.com:teivienn/caricamento.git
cd caricamento
npm install
npm run build
npm link        # команда `caricamento` становится доступна глобально
```

## Быстрый старт

В корне вашего Android/RN/Expo-проекта:

```bash
caricamento init       # сгенерировать caricamento.config.ts
caricamento doctor     # проверить окружение и креды
caricamento detect     # убедиться, что тип проекта определился верно

# сухой прогон — покажет план и команду gradlew, ничего не выполняя
caricamento release --platform android --targets firebase --dry-run --verbose

# настоящий релиз: сборка → подпись → проверка → Firebase → рассылка группе
caricamento release --platform android --targets firebase
```

## Настройка Firebase App Distribution

Разовая настройка (в браузере, ~5 минут):

1. **Firebase-проект**: [console.firebase.google.com](https://console.firebase.google.com)
   → создать проект (хватит бесплатного Spark).
2. **Android-приложение**: в проекте → «Добавить приложение» → Android,
   package name должен совпадать с `applicationId` вашего приложения.
   Скопируйте **App ID** вида `1:123456789:android:abc123...`
   (файл google-services.json не нужен).
3. **Группа тестеров**: раздел App Distribution → Testers & Groups →
   создать группу, например `qa`. Имя группы — это её alias для конфига.
4. **Service account**: [Google Cloud Console](https://console.cloud.google.com)
   (тот же проект) → IAM → Service Accounts → создать → роль
   **Firebase App Distribution Admin** → создать JSON-ключ.
5. Сохраните ключ и укажите путь:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/firebase-sa.json
```

## Настройка Google Play

Публикация в Play Console работает через Play Developer API v3 (транзакционный
«edit»: upload AAB → трек → commit). Разовая настройка (~10 минут, нужен
аккаунт разработчика Google Play, $25):

**Шаг 1. Проект в Google Cloud.** Откройте
[console.cloud.google.com](https://console.cloud.google.com) → в верхней
панели кликните на селектор проектов (слева от поиска) → **New Project** →
имя (например, `caricamento-play`) → **Create**. Можно использовать и
существующий проект (в т.ч. тот, что Firebase создал автоматически).

**Шаг 2. Включите Google Play Android Developer API.**
Проще всего по прямой ссылке:
[console.cloud.google.com/apis/library/playdeveloper.googleapis.com](https://console.cloud.google.com/apis/library/playdeveloper.googleapis.com)
→ убедитесь, что в селекторе сверху выбран нужный проект → кнопка **Enable**.
Вручную то же самое: меню ☰ → **APIs & Services** → **Library** → в поиске
`Google Play Android Developer API` → открыть → **Enable**.

**Шаг 3. Создайте service account.** Прямая ссылка:
[console.cloud.google.com/iam-admin/serviceaccounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
→ **Create Service Account** → имя `play-publisher` → **Create and Continue** →
шаг «Grant this service account access to project» **пропустите** (роль в
Google Cloud не нужна — доступ выдаётся в Play Console) → **Done**.

**Шаг 4. Скачайте JSON-ключ.** В списке service accounts кликните на email
созданного (`play-publisher@...iam.gserviceaccount.com`) → вкладка **Keys** →
**Add Key** → **Create new key** → **JSON** → **Create** — файл
`project-....json` скачается автоматически. Это единственная копия ключа,
перевыпустить можно только новый.

**Шаг 5. Пригласите service account в Play Console.**
Страница «Setup → API access» **упразднена** — теперь сервисный аккаунт
приглашается как обычный пользователь. Откройте
[play.google.com/console](https://play.google.com/console) → в левом меню
**Users and permissions** → **Invite new users** → в поле email вставьте
адрес сервисного аккаунта из шага 3
(`play-publisher@<project>.iam.gserviceaccount.com`).

**Шаг 6. Выдайте права** (там же, в форме приглашения). Вкладка
**Account permissions** — минимум для публикации:

- **View app information and download bulk reports (read-only)** — обязательно;
- **Release apps to testing tracks** — для internal/alpha/beta;
- **Release to production, exclude devices and use Play app signing** —
  только если планируете продакшен через API (для тестовых треков не нужно).

Либо на вкладке **App permissions** выдайте права только на конкретное
приложение. Затем **Invite user** — для сервисных аккаунтов подтверждение
не требуется, статус сразу становится Active.

**Шаг 7. Сохраните ключ в Keychain**:

```bash
caricamento secrets set play/service-account   # вставьте ПУТЬ к скачанному JSON
```

Конфигурация таргета:

```typescript
targets: {
  play: {
    serviceAccountRef: 'secret:play/service-account',
    packageName: 'com.example.app',   // applicationId приложения
    track: 'internal',                // internal | alpha | beta | production (по умолчанию internal)
    status: 'completed',              // completed | draft (по умолчанию completed)
    releaseNotes: 'Что нового',       // опционально; перекрывается флагом --release-notes
  },
},
```

Особенности:

- **Только AAB.** Play не принимает APK — когда `play` есть среди таргетов,
  `release` автоматически переключает сборку на AAB (Firebase принимает AAB
  тоже, поэтому комбинированный запуск `--targets firebase,play` корректен).
- **mapping.txt** (R8/ProGuard), если он собрался вместе с AAB, выгружается
  автоматически — краши в Play Console будут деобфусцированы.
- **versionCode должен строго возрастать.** Стратегия
  `version: { strategy: 'auto-increment' }` запрашивает текущий максимум
  через Play API и ставит +1 (для первого релиза — 1). Без `targets.play`
  эта стратегия недоступна (будет ConfigError с подсказкой).
- При сбое после открытия edit-сессии (например, ошибка валидации на commit)
  edit удаляется автоматически — «висючих» черновиков в Play Console не
  остаётся.

**Важные ограничения API:**
- Приложение должно **уже существовать** в Play Console — первое создание
  приложения делается только руками через веб-интерфейс.
- Первый релиз на production-трек тоже обычно делается вручную; API удобен
  для internal/alpha/beta.

## Конфигурация

`caricamento.config.ts` в корне проекта (создаётся через `caricamento init`):

```typescript
export default {
  project: { type: 'auto' },   // auto | android | ios | react-native | flutter

  android: {
    module: 'app',             // gradle-модуль
    flavor: 'prod',            // опционально
    buildType: 'release',
    signing: {
      injection: 'init-script', // см. «Подпись» ниже
      keystoreRef: 'secret:android/keystore-path',
      keystorePasswordRef: 'secret:android/keystore-password',
      keyAlias: 'upload',
      keyPasswordRef: 'secret:android/key-password',
      // опционально: сверка отпечатка после сборки
      expectedCertificateSha256: 'f440:2b55:...',
    },
  },

  version: { strategy: 'timestamp' }, // manual | timestamp | auto-increment

  targets: {
    firebase: {
      appIdAndroid: '1:123456789:android:abc123',
      groups: ['qa'],                // alias'ы групп из Firebase Console
      testers: ['dev@example.com'],  // опционально, email'ы напрямую
      releaseNotes: 'Что нового в этой сборке',
    },
    play: {                          // см. «Настройка Google Play»
      serviceAccountRef: 'secret:play/service-account',
      packageName: 'com.example.app',
      track: 'internal',
    },
  },
};
```

`auto-increment` требует `targets.play`: versionCode вычисляется как
текущий максимум в Play Console + 1.

### Секреты

В конфиге — только ссылки `secret:<name>`, никогда сами значения.
Резолв по цепочке: **env vars → macOS Keychain →
`~/.caricamento/projects/<name>.env` → `.env` в проекте**.
Имя `android/keystore-password` маппится на env var
`ANDROID_KEYSTORE_PASSWORD` (слеши и дефисы → подчёркивания, upper case).

**Keychain (рекомендуется локально)** — один раз кладёте, работает из любой
директории, видно в Keychain Access.app (поиск «caricamento»):

```bash
caricamento secrets set android/keystore-path      # скрытый ввод
caricamento secrets set android/keystore-password
caricamento secrets set android/key-password
caricamento secrets set firebase/service-account   # путь к JSON-ключу + serviceAccountRef в конфиге
caricamento secrets list                           # только имена
caricamento secrets delete <name>
```

**`.env`** — рядом с конфигом: для реестра это `~/.caricamento/projects/<name>.env`,
для in-project режима — `.env` в корне проекта (держите его в `.gitignore`):

```bash
ANDROID_KEYSTORE_PATH=/abs/path/to/upload.keystore
ANDROID_KEYSTORE_PASSWORD=...
ANDROID_KEY_PASSWORD=...
GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/firebase-sa.json
```

В CI всё приходит через переменные окружения — тот же код без изменений.

## Подпись Android

Два режима (`android.signing.injection`):

### `init-script` (по умолчанию, рекомендуется)

Caricamento генерирует Gradle init script, который извне переопределяет
`signingConfig` релизного build type и версию, и запускает
`./gradlew -I <script>`. **Проект не модифицируется вообще** — работает с
ванильными шаблонами RN/Expo и переживает регенерацию `android/`.

Скрипт содержит пароли открытым текстом, поэтому пишется во временный файл
с правами `0600` и удаляется сразу после сборки.

### `properties`

Подпись передаётся через `-PCARICAMENTO_STORE_FILE=...` и т.д., а
`build.gradle` проекта читает эти properties. Для проектов, предпочитающих
явную конфигурацию. Рабочий пример — `fixtures/android-native/app/build.gradle`.

### Создание upload-keystore для реального проекта

```bash
keytool -genkeypair -v -keystore upload.keystore -alias upload \
  -keyalg RSA -keysize 2048 -validity 10000
```

Keystore и пароли храните вне репозитория (или зашифрованными). Для Google
Play в будущем рекомендуется Play App Signing — тогда этот ключ будет
только upload-ключом.

## Поддерживаемые проекты

| Тип | Детекция | Особенности |
|---|---|---|
| Нативный Android | `settings.gradle` | gradlew в корне |
| React Native CLI | `package.json` + `android/` | сборка в `android/`, нужен `npm install` |
| Expo (bare) | то же + `app.json` | `expo prebuild` один раз; `--clean` безопасен |
| Flutter | `pubspec.yaml` | детекция есть, сборка — в roadmap |

Expo в managed workflow (без `android/`): пока нужно один раз выполнить
`npx expo prebuild --platform android`. Автоматический prebuild как шаг
пайплайна — в roadmap.

## Режим командного центра (без файлов в проекте)

Caricamento может работать вообще не оставляя следов в целевом проекте:
подпись инжектируется через init-script, а конфиги и состояние живут в
`~/.caricamento/`.

```bash
# один раз регистрируете проект — создастся стартовый конфиг в ~/.caricamento/projects/
caricamento projects add myapp --path ~/work/myapp

# дальше — из любой директории, без флагов
caricamento release myapp
caricamento doctor myapp
caricamento projects list
```

Цепочка резолва конфига: `--config` → конфиг из записи реестра →
`~/.caricamento/projects/<name>.config.ts` → `caricamento.config.ts` в проекте.
`--platform` по умолчанию `android`, `--targets` — все сконфигурированные
таргеты. Секреты — через env vars или Keychain, `.env` в проекте не нужен.

## Команды

```
caricamento init                          # шаблон caricamento.config.ts (in-project режим)
caricamento projects add|list|remove      # реестр проектов (command center)
caricamento secrets set|get|delete|list   # секреты в macOS Keychain
caricamento doctor [project]              # проверка окружения и кредов
caricamento detect [project]              # показать дескриптор проекта

caricamento build   [project] [--platform android] [--artifact-type apk|aab]
                    [--build <n>] [--version <name>]
caricamento upload  [project] --target firebase|play [--artifact <path>] [--release-notes <text>]
caricamento release [project] [--targets firebase,play] [...]

caricamento runs                          # история запусков
caricamento status <runId>                # сводка по запуску
```

Глобальные флаги: `--config <path>`, `--verbose`, `--json`, `--dry-run`.

Каждый запуск пишет журнал событий в `~/.caricamento/runs/<runId>.jsonl` —
там же полные логи gradle и тела ошибок API.

## Использование в CI

```bash
export ANDROID_KEYSTORE_PATH=$RUNNER_TEMP/upload.keystore
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_PASSWORD=...
export GOOGLE_APPLICATION_CREDENTIALS=$RUNNER_TEMP/firebase-sa.json

caricamento release --platform android --targets firebase --json
```

Коды выхода: `0` — успех; `2` — валидация; `3` — сборка; `4` — подпись;
`5` — загрузка; `6` — конфиг.

## Troubleshooting

| Ошибка | Причина и решение |
|---|---|
| `gradlew not found` | Нет wrapper'а: `gradle wrapper` в android-проекте (нужен установленный gradle: `brew install gradle`) |
| Firebase `HTTP 404` при upload | Неверный App ID, либо package name APK не совпадает с зарегистрированным в Firebase |
| Firebase `404` при distribute | Нет такой группы — проверьте alias в App Distribution → Testers & Groups |
| Firebase `401/403` | Service account без роли Firebase App Distribution Admin, либо не задан `GOOGLE_APPLICATION_CREDENTIALS` |
| Play `401/403` | Service account не приглашён в Play Console (Users and permissions) или без прав на релизы |
| Play `404` | `targets.play.packageName` не совпадает с существующим приложением в Play Console |
| Play commit: `Version code ... has already been used` | versionCode не возрастает — используйте `version.strategy: 'auto-increment'` |
| `auto-increment requires targets.play` | Стратегия опрашивает Play API — настройте `targets.play` или смените стратегию |
| `Signer certificate SHA-256` не совпадает | Подписали не тем keystore — сверьте `expectedCertificateSha256` |
| Play: `Target SDK of artifact is too low: N` | N — это versionCode артефакта, а не SDK. С 31.08.2026 обновления обязаны таргетить API 36 — поднимите `targetSdkVersion` |
| Play: `APK ... not allowed` / просит AAB | Play принимает только AAB — `release` сам переключает apk→aab, для `upload` передайте `--artifact-type aab` |

## Разработка

```bash
npm run build       # tsup → dist/
npm test            # vitest, 77 тестов (Android SDK / Firebase / Play не нужны)
npm run typecheck
npm run lint        # eslint + правила границ слоёв (SPEC §3.1)
```

`fixtures/` — реальные проекты для ручных end-to-end прогонов:
`android-native` (properties-инжекция), `react-native-cli` и
`react-native-expo` (init-script), `flutter` (маркер для детектора).
Подробности — [fixtures/README.md](fixtures/README.md).

## Roadmap

- **Phase 3** — iOS: `xcodebuild`, подпись (automatic/manual), App Store
  Connect + TestFlight
- ~~**Phase 4** — Google Play~~ — ✅ реализовано: edits flow, треки,
  auto-increment versionCode
- **Phase 5** — идемпотентность, ретраи, manual signing для CI
- **Phase 6** — локальный HTTP API + UI поверх того же core

Полная спецификация архитектуры и планов — [SPEC.md](SPEC.md).
