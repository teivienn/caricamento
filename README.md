# caricamento

CLI для сборки, подписи и доставки мобильных релизов. Одна команда —
от исходников до установленной сборки у тестировщиков.

**Статус: MVP** — Android (нативный, React Native CLI, Expo) + Firebase App
Distribution + Google Play; iOS (Xcode, React Native) + App Store Connect /
TestFlight — см. раздел [iOS](#ios). Архитектура и планы — [SPEC.md](SPEC.md).

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
- Internal App Sharing: загрузка APK/AAB и готовая ссылка на установку
- Сборка iOS .ipa через `xcodebuild archive` + `-exportArchive`
  (exportOptions.plist генерируется из конфига, dSYMs собираются рядом);
  подпись automatic (API-ключ ASC) или manual (временный keychain для CI)
- App Store Connect / TestFlight: загрузка через Build Uploads API (или
  altool) → ожидание обработки → «What to Test» → beta-группы
- **Идемпотентность**: повторный релиз с тем же versionCode не создаёт дублей
  (Firebase, Play и App Store Connect сами находят уже загруженный билд)
- Release notes из git: заметки генерируются из коммитов с последнего тега
- `caricamento apk`: конвертация AAB → universal APK для локальной установки
  (bundletool)
- Стратегия версионирования `auto-increment`: versionCode / CFBundleVersion =
  текущий максимум в Play, App Store Connect или Firebase App Distribution + 1
  (на выбор, `version.source`)
- Варианты сборки (qa/prod): несколько applicationId / bundle ID из одного
  проекта без правки его файлов
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
| Xcode (полный, не только CLT) | сборка iOS | `xcodebuild -version`, `caricamento doctor` |

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

### Конфигурация `targets.play` — все опции

```typescript
targets: {
  play: {
    serviceAccountRef: 'secret:play/service-account', // обязательно
    packageName: 'com.example.app',                   // обязательно
    track: 'internal',
    status: 'completed',
    releaseNotes: 'Что нового',
  },
},
```

| Поле | Тип | Дефолт | Описание |
|---|---|---|---|
| `serviceAccountRef` | `secret:<name>` | — | **Обязательно.** Секрет с путём к JSON-ключу service account (или самим JSON). Шаги 1–7 выше |
| `packageName` | string | — | **Обязательно.** `applicationId` приложения, как в Play Console |
| `track` | `internal` \| `alpha` \| `beta` \| `production` | `internal` | Трек публикации (подробнее ниже) |
| `status` | `completed` \| `draft` | `completed` | `draft` — релиз остаётся черновиком на треке, не публикуется; `completed` — доступен тестировщикам/пользователям трека сразу |
| `releaseNotes` | string | — | Текст «Что нового» (локаль `en-US`; мультиязычность — в roadmap). Перекрывается флагом `--release-notes` |

### Особенности поведения

- **Только AAB.** Play не принимает APK — когда `play` есть среди таргетов,
  `release` автоматически переключает сборку на AAB (Firebase принимает AAB
  тоже, поэтому комбинированный запуск `--targets firebase,play` корректен).
- **mapping.txt** (R8/ProGuard), если он собрался вместе с AAB, выгружается
  автоматически — краши в Play Console будут деобфусцированы.
- **versionCode должен строго возрастать.** Стратегия
  `version: { strategy: 'auto-increment' }` запрашивает текущий максимум
  через Play API и ставит +1 (для первого релиза — 1). Источник можно
  переопределить через `version.source` — см. «Версионирование» ниже.
- При сбое после открытия edit-сессии (например, ошибка валидации на commit)
  edit удаляется автоматически — «висючих» черновиков в Play Console не
  остаётся.

### Треки

| Трек | Кому доступен | Типичное применение |
|---|---|---|
| `internal` | До 100 тестировщиков, без ревью Google | Ежедневные сборки для команды/QA |
| `alpha` | Закрытое тестирование по спискам | Стабильные сборки для расширенной группы |
| `beta` | Открытое или закрытое бета-тестирование | Предрелизная проверка |
| `production` | Все пользователи | Релиз (права «Release to production…») |

Один запуск — один трек. Трек задаётся в конфиге; для разовой смены удобно
держать несколько зарегистрированных проектов с разными конфигами:

```bash
caricamento projects add myapp-qa  --path ~/work/myapp --config ~/.caricamento/projects/myapp-qa.config.ts   # track: internal
caricamento projects add myapp-beta --path ~/work/myapp --config ~/.caricamento/projects/myapp-beta.config.ts # track: beta

caricamento release myapp-qa     # internal
caricamento release myapp-beta   # beta
```

### Типовые сценарии

```bash
# QA-сборка в internal (при auto-increment версия поднимется сама)
caricamento release myapp

# То же + заметки к релизу разово, без правки конфига
caricamento release myapp --release-notes "Фикс краша на старте"

# Черновик на beta-треке (не публикуется, проверяете в консоли руками)
#   в конфиге: track: 'beta', status: 'draft'
caricamento release myapp-beta

# Одновременно в Firebase (группа qa) и Play (internal)
caricamento release myapp --targets firebase,play
```

### Пока не поддерживается (roadmap)

- **Промоушен существующего билда** между треками без пересборки
  (internal → production тем же versionCode) — сейчас каждый запуск
  собирает и загружает новый билд;
- **Staged rollout** (`userFraction`, процентный раскат на production);
- несколько треков за один запуск;
- мультиязычные release notes (сейчас только `en-US`);
- кастомное имя релиза (Play формирует его из versionName).

**Важные ограничения API:**
- Приложение должно **уже существовать** в Play Console — первое создание
  приложения делается только руками через веб-интерфейс.
- Первый релиз на production-трек тоже обычно делается вручную; API удобен
  для internal/alpha/beta.

## Internal App Sharing (таргет `playsharing`)

Быстрый способ раздать сборку по ссылке, без треков и групп тестеров:
загрузка APK или AAB в Play Internal App Sharing, в ответ — `downloadUrl`,
по которому сборка ставится через Play Store (у получателя должен быть
включён internal app sharing и разрешённый Google-аккаунт).

Используется тот же service account, что и для Play (scope
`androidpublisher`). Конфиг:

```typescript
targets: {
  playsharing: {
    serviceAccountRef: 'secret:play/service-account',
    packageName: 'com.example.app',
  },
},
```

```bash
caricamento release myapp --targets playsharing          # сборка + ссылка
caricamento upload myapp --target playsharing --artifact app-release.aab
```

Ссылка печатается в логе шага и доступна в `PublishResult.url` (в `--json`
выводе — поле `url`).

**Разово в Play Console** (иначе API вернёт `TOS_NOT_ACCEPTED`):
Setup → Internal app sharing → включить и принять условия сервиса.

## iOS

Сборка `.ipa` через Xcode и доставка в TestFlight. Поддерживаются нативные
Xcode-проекты и React Native (проект в `ios/`).

### Требования

| Что | Зачем | Нужен платный аккаунт ($99/год)? |
|---|---|---|
| macOS + Xcode (полный, `sudo xcode-select -s /Applications/Xcode.app`) | `xcodebuild`, `security`, `codesign` | нет |
| Неподписанная сборка (`signing.mode: 'none'`) | проверить, что проект собирается | **нет** |
| Сертификат Apple Distribution + App ID | подписанная .ipa | да (Apple Developer Program) |
| Запись приложения в App Store Connect | TestFlight, auto-increment из ASC | да |
| API-ключ App Store Connect (`.p8`) | automatic signing без логина в Xcode, загрузка, TestFlight | да |
| CocoaPods (`pod install` в `ios/`) | React Native | нет (выполняется вами, caricamento его не запускает) |

**Что работает локально без аккаунта:** `build --platform ios` в режиме
`none` (archive без подписи → неподписанная .ipa + dSYMs), `doctor`,
`detect`, `--dry-run` любых команд. Всё, что подписывает или ходит в App
Store Connect, требует платного аккаунта.

### API-ключ App Store Connect

1. [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Users
   and Access** → **Integrations** → **App Store Connect API** → вкладка
   **Team Keys** → **Generate API Key** (роль **App Manager** — хватает для
   загрузки и TestFlight; для automatic signing с созданием профилей может
   понадобиться **Admin**).
2. Скачайте `AuthKey_<KEY_ID>.p8` — скачать можно только один раз.
3. Запишите **Key ID** (в строке ключа) и **Issuer ID** (над таблицей).
4. Сохраните ключ:

```bash
caricamento secrets set asc/private-key   # путь к AuthKey_XXXX.p8 (или сам PEM)
```

### Конфигурация — все опции

```typescript
export default {
  project: { type: 'ios' },             // или 'react-native' / 'auto'

  ios: {
    project: 'App.xcodeproj',           // РОВНО одно из project / workspace
    // workspace: 'App.xcworkspace',    // CocoaPods / RN (путь от ios/ или от корня)
    scheme: 'App',                      // схема должна быть Shared
    configuration: 'Release',
    destination: 'generic/platform=iOS',
    signing: {
      mode: 'automatic',                // automatic | manual | none
      method: 'app-store',              // app-store | ad-hoc | development | enterprise
      teamId: 'ABCDE12345',
      bundleId: 'com.example.app',      // опционально: PRODUCT_BUNDLE_IDENTIFIER
      // automatic — ключ ASC (если не задан, берётся из targets.appstore,
      // а без него — аккаунты, залогиненные в Xcode):
      apiKeyRef: 'secret:asc/private-key',
      keyId: 'XYZ123ABCD',
      issuerId: '69a6de7e-...',
      // manual:
      certificateRef: 'secret:ios/certificate',          // .p12: путь или base64
      certificatePasswordRef: 'secret:ios/certificate-password',
      profileRefs: ['secret:ios/profile-app'],           // .mobileprovision: путь или base64
    },
  },

  version: { strategy: 'auto-increment', name: '1.4.0' }, // source по умолчанию — appstore

  targets: {
    appstore: {
      apiKeyRef: 'secret:asc/private-key',
      keyId: 'XYZ123ABCD',
      issuerId: '69a6de7e-...',
      bundleId: 'com.example.app',      // как в App Store Connect
      distributeTo: 'testflight',       // 'appstore' — roadmap
      betaGroups: ['QA'],
      whatToTest: 'Проверьте экран логина',
      locale: 'en-US',
      upload: 'api',                    // api | altool
      processingTimeoutMinutes: 30,
    },
  },
};
```

**Блок `ios`:**

| Поле | Тип | Дефолт | Описание |
|---|---|---|---|
| `project` / `workspace` | string | — | **Ровно одно из двух.** Путь резолвится от `<root>/ios` (RN) или корня проекта |
| `scheme` | string | — | **Обязательно.** Схема должна быть Shared (`xcshareddata/xcschemes`) |
| `configuration` | string | `Release` | Build configuration |
| `destination` | string | `generic/platform=iOS` | `-destination` для archive |
| `signing.mode` | `automatic` \| `manual` \| `none` | `automatic` | См. «Режимы подписи» |
| `signing.method` | `app-store` \| `ad-hoc` \| `development` \| `enterprise` | `app-store` | Метод экспорта; в plist пишутся актуальные имена Xcode (`app-store-connect`, `release-testing`, `debugging`, `enterprise`) |
| `signing.teamId` | string | — | `DEVELOPMENT_TEAM` и `teamID` в exportOptions; сверяется с подписью готовой .ipa |
| `signing.bundleId` | string | — | Переопределение `PRODUCT_BUNDLE_IDENTIFIER` (обычно — через вариант) |
| `signing.apiKeyRef` / `keyId` / `issuerId` | secret / string | — | automatic: API-ключ ASC. Задаются только вместе |
| `signing.certificateRef` | `secret:<name>` | — | manual: `.p12` (путь или base64). Без него — identities из вашего keychain |
| `signing.certificatePasswordRef` | `secret:<name>` | — | Обязателен вместе с `certificateRef` |
| `signing.profileRefs` | `secret:<name>[]` | — | **Обязательно для manual.** `.mobileprovision` (путь или base64) |

**Блок `targets.appstore`:**

| Поле | Тип | Дефолт | Описание |
|---|---|---|---|
| `apiKeyRef` | `secret:<name>` | — | **Обязательно.** `.p8` (путь или PEM) |
| `keyId` / `issuerId` | string | — | **Обязательно.** Из App Store Connect → Integrations |
| `bundleId` | string | — | **Обязательно.** Bundle ID приложения в ASC; сверяется с Info.plist .ipa |
| `distributeTo` | `testflight` \| `appstore` | `testflight` | `appstore` (сабмит на ревью) — roadmap, сейчас ошибка валидации |
| `betaGroups` | string[] | `[]` | Имена TestFlight-групп; проверяются **до** загрузки |
| `whatToTest` | string | — | «What to Test»; перекрывается `--release-notes`, иначе git changelog |
| `locale` | string | `en-US` | Локаль «What to Test» |
| `upload` | `api` \| `altool` | `api` | Механизм загрузки бинаря |
| `processingTimeoutMinutes` | number | `30` | Сколько ждать обработки билда в ASC |

### Режимы подписи

- **`automatic`** (по умолчанию) — `xcodebuild -allowProvisioningUpdates`
  с `-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID`:
  Xcode сам создаёт сертификаты/профили через API. `.p8` пишется во
  временный файл (0600) и удаляется после сборки. Удобно локально и для
  старта; без ключа используются аккаунты из Xcode → Settings → Accounts.
- **`manual`** (для CI) — `.p12` импортируется во **временный keychain**
  (`security create-keychain` → `import` → `set-key-partition-list` →
  добавление в search list), профили декодируются (`security cms -D`),
  проверяются (срок, bundle ID) и копируются в каталоги Provisioning
  Profiles. В exportOptions — `provisioningProfiles` (bundle ID → UUID) и
  SHA-1 сертификата. После сборки — всё откатывается: search list
  восстанавливается, keychain и добавленные профили удаляются.
  В CI секреты удобно передавать base64 через env:
  `IOS_CERTIFICATE=$(base64 -i dist.p12)`, `IOS_PROFILE_APP=$(base64 -i App.mobileprovision)`.
- **`none`** — без подписи (`CODE_SIGNING_ALLOWED=NO`), `.app` упаковывается
  в неподписанный .ipa. Только для проверки сборки; `release` с
  `appstore` в этом режиме отклоняется.

После экспорта подпись проверяется: `codesign --verify --deep --strict` и
сверка TeamIdentifier с `signing.teamId`.

### Версия и bundle ID без правки проекта

`MARKETING_VERSION` (versionName) и `CURRENT_PROJECT_VERSION` (build number)
передаются в `xcodebuild archive` как build settings. Info.plist проекта
должен ссылаться на `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` —
это дефолт шаблонов Xcode 13+ и RN; после архива caricamento проверяет
значения в архиве и падает с подсказкой, если они не применились.
Bundle ID из `signing.bundleId` / варианта передаётся как
`PRODUCT_BUNDLE_IDENTIFIER` (ограничение: применяется ко **всем** таргетам
схемы — для приложений с extensions используйте build configurations
проекта).

### Поток TestFlight

`caricamento release --platform ios --targets appstore` (алиас `asc`):

1. сборка и подпись .ipa, проверка подписи;
2. поиск приложения по `bundleId` и TestFlight-групп (опечатка в группе —
   ошибка сразу, а не после получаса ожидания);
3. если билд с таким `CFBundleVersion` уже есть в ASC — загрузка
   пропускается (повторный запуск безопасен);
4. загрузка: Build Uploads API (`POST /v1/buildUploads` →
   `POST /v1/buildUploadFiles` → PUT частей по presigned URL →
   `PATCH /v1/buildUploadFiles/{id}`), либо `xcrun altool --upload-app`
   при `upload: 'altool'`;
5. ожидание обработки до `VALID` (опрос каждые 30 с, прогресс в логе,
   таймаут `processingTimeoutMinutes`); `FAILED`/`INVALID` — ошибка с
   деталями Apple;
6. «What to Test» (`whatToTest` / `--release-notes` / git changelog);
7. добавление билда в `betaGroups`.

Загрузить готовый .ipa без сборки:

```bash
caricamento upload --target appstore --artifact build/caricamento/ipa/App.ipa
```

**Пока не поддерживается (roadmap):** сабмит на App Store review
(`distributeTo: 'appstore'`), отправка на Beta App Review для внешних групп
(билд добавляется в группу, ревью запускается вручную в ASC), декларация
export compliance через API — добавьте `ITSAppUsesNonExemptEncryption = NO`
в Info.plist, иначе TestFlight покажет «Missing Compliance».

### Быстрая проверка без аккаунта

```bash
cd fixtures/ios-native
node ../../dist/cli/index.js doctor
node ../../dist/cli/index.js build --platform ios   # → build/caricamento/ipa/CaricamentoFixture.ipa
```

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
                                      // (+ source: 'play' | 'appstore' | 'firebase')

  // ios: { ... }                     // см. раздел «iOS»

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

### Версионирование

| Стратегия | Android versionCode | iOS CFBundleVersion | Источник |
|---|---|---|---|
| `manual` | `version.buildNumber` или `--build <n>` | то же | — |
| `timestamp` | Unix-секунды | `YYYYMMDDHHMM` (UTC) | — |
| `auto-increment` | текущий максимум + 1 | текущий максимум + 1 | Play, App Store Connect или Firebase |

Для `auto-increment` источник выбирается так: явный `version.source`
(`'play'` / `'appstore'` / `'firebase'`) — применяется к любой платформе;
иначе по приоритету **play > appstore > firebase** среди настроенных
таргетов, родных для собираемой платформы: `targets.play` — только для
Android, `targets.appstore` — только для iOS, `targets.firebase` — для обеих.
Play — источник истины (все треки). `appstore` — max числового
`CFBundleVersion` среди всех билдов приложения в App Store Connect
(нечисловые вида `1.2.3` игнорируются; билдов нет — первый будет `1`).
Firebase видит только сборки, загруженные в App Distribution (max
`buildVersion` среди релизов).

`versionName` / `CFBundleShortVersionString` всегда вручную: `version.name`
в конфиге или `--version 1.0.4`. Флаги CLI перекрывают конфиг.

**Совет: versionName из package.json.** Конфиг — исполняемый TypeScript,
поэтому версию можно читать прямо из проекта. Перед загрузкой конфига
выставляется `CARICAMENTO_PROJECT_DIR` (абсолютный путь к проекту) — это
работает и для конфигов реестра в `~/.caricamento/projects/`:

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(process.env.CARICAMENTO_PROJECT_DIR!, 'package.json'), 'utf8'),
);

export default {
  version: { strategy: 'auto-increment', name: pkg.version },
  // ...
};
```

(Для in-project конфига можно и от файла конфига:
`new URL('./package.json', import.meta.url)` — но вариант с
`CARICAMENTO_PROJECT_DIR` универсален.)

### Варианты сборки (qa/prod)

Одно приложение можно публиковать под несколькими applicationId — например,
`com.example.app.qa` для внутреннего тестирования и `com.example.app` для
релиза. Варианты описываются в блоке `variants`:

```typescript
export default {
  // ...базовый android/signing/version...

  targets: {
    firebase: { appIdAndroid: '1:123:android:base', groups: ['qa'] },
  },

  variants: {
    qa: {
      applicationId: 'com.example.app.qa',   // инжектируется в сборку извне
      targets: {                             // ПОЛНОСТЬЮ заменяют базовые targets
        firebase: { appIdAndroid: '1:123:android:qa', groups: ['qa'] },
      },
    },
    prod: {
      applicationId: 'com.example.app',
      targets: {
        play: {
          serviceAccountRef: 'secret:play/service-account',
          packageName: 'com.example.app',
          track: 'internal',
        },
      },
      version: { strategy: 'auto-increment' }, // заменяет базовый version
    },
  },
};
```

Запуск:

```bash
caricamento release myapp --variant qa     # один вариант
caricamento release myapp --variant all    # все варианты последовательно
caricamento build --variant prod --artifact-type aab
```

`--variant all` прогоняет каждый вариант отдельным пайплайном (свой runId,
свои секреты/таргеты/версия): упавший вариант не останавливает остальные,
в конце печатается сводка по всем вариантам, а код выхода ненулевой, если
упал хотя бы один.

Правила слияния (намеренно простые, без deep merge):

- `applicationId` и `flavor` из варианта дополняют блок `android`;
- `bundleId` из варианта перекрывает `ios.signing.bundleId` (передаётся в
  `xcodebuild` как `PRODUCT_BUNDLE_IDENTIFIER`; игнорируется, если блока
  `ios` нет). Для TestFlight у варианта обычно свой `targets.appstore` с тем
  же `bundleId`;
- `targets` варианта **заменяют** базовые целиком — вариант публикуется
  ровно туда, куда указано;
- `version` варианта заменяет базовый блок целиком.

**Как инжектируется applicationId.** Тем же способом, что подпись: в режиме
`init-script` сгенерированный Gradle init script выставляет
`android.defaultConfig.applicationId` в `afterEvaluate` — **файлы проекта не
модифицируются**, варианты работают на ванильных шаблонах и переживают
`expo prebuild --clean` (ре-пребилд не нужен). В режиме `properties`
передаётся `-PCARICAMENTO_APPLICATION_ID=...` — тогда `build.gradle` проекта
должен прочитать это свойство сам (по аналогии с `-PCARICAMENTO_VERSION_CODE`).

**Когда вместо этого использовать `flavor`.** Если варианты уже определены
в Gradle проекта (productFlavors со своими applicationId/applicationIdSuffix),
не дублируйте их — укажите в варианте только `flavor: 'qa'`, и caricamento
соберёт `:app:assembleQaRelease`. `applicationId`-инжекция нужна проектам
без flavor'ов (типичный RN/Expo).

Каждый applicationId должен быть зарегистрирован на стороне стора: отдельное
приложение в Firebase (свой `appIdAndroid`) и/или в Play Console (свой
`packageName`).

### Release notes из git

Заметки к релизу можно не писать руками — блок `changelog` генерирует их из
истории коммитов целевого проекта:

```typescript
export default {
  // ...
  changelog: { source: 'git', maxCommits: 20 },  // maxCommits — fallback, если в репо нет тегов
};
```

Берутся коммиты с последнего git-тега (`git describe --tags --abbrev=0`),
без merge-коммитов, по строке `- <subject>` на коммит. Если тегов нет —
последние `maxCommits` коммитов. Приоритет источников заметок:
флаг `--release-notes` → `releaseNotes` в конфиге таргета → git changelog.
Шаг запускается, только когда заметки кому-то нужны (хотя бы у одного
таргета нет своих).

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

## Повторные запуски (идемпотентность)

Повторный `release` с тем же versionCode не создаёт дублей:

- **Firebase**: перед загрузкой проверяется `releases.list` — если релиз с
  таким `buildVersion` уже есть, upload и установка release notes
  пропускаются (в логе «already uploaded»), а рассылка группам выполняется
  как обычно (она идемпотентна).
- **Play**: versionCode нельзя загрузить дважды, поэтому перед открытием
  edit-сессии делается пробный запрос треков. Код уже на целевом треке →
  «already published», ничего не коммитится. Код есть на другом треке →
  коммитится только `tracks.update` с существующим кодом — это даёт базовый
  промоушен билда между треками без пересборки.

Флага `--force` нет: чтобы перезалить билд, поднимите versionCode
(с `auto-increment` это происходит само).

## Локальная установка: AAB → APK

```bash
caricamento apk myapp                          # newest AAB из build outputs
caricamento apk myapp --artifact app-release.aab --out /tmp/app.apk
```

Конвертирует AAB в universal APK через bundletool (`build-apks
--mode=universal`) и подписывает ключом из `android.signing` (без него —
debug-подпись bundletool). Резолв bundletool по цепочке:
`$BUNDLETOOL_PATH` → `bundletool` в PATH → `~/.caricamento/tools/
bundletool.jar` (скачивается один раз с GitHub-релиза google/bundletool и
кэшируется) → ошибка с подсказкой `brew install bundletool`.
Итоговый путь печатается в логе; дальше `adb install <path>`.

## Поддерживаемые проекты

| Тип | Детекция | Особенности |
|---|---|---|
| Нативный Android | `settings.gradle` | gradlew в корне |
| Нативный iOS | `*.xcodeproj` / `*.xcworkspace` | `--platform ios`, блок `ios` в конфиге |
| React Native CLI | `package.json` + `android/` | сборка в `android/` / `ios/`, нужен `npm install` (+ `pod install` для iOS) |
| Expo (bare) | то же + `app.json` | `expo prebuild` один раз; `--clean` безопасен |
| Flutter | `pubspec.yaml` | детекция есть, сборка — в roadmap (iOS: вручную `flutter build ios --config-only`, затем `ios.workspace: 'Runner.xcworkspace'`) |

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
таргеты, применимые к платформе (для iOS — `appstore` и `firebase`, для
Android — `firebase`, `play`, `playsharing`). Секреты — через env vars или Keychain, `.env` в проекте не нужен.

## Команды

```
caricamento init                          # шаблон caricamento.config.ts (in-project режим)
caricamento projects add|list|remove      # реестр проектов (command center)
caricamento secrets set|get|delete|list   # секреты в macOS Keychain
caricamento doctor [project]              # проверка окружения и кредов
caricamento detect [project]              # показать дескриптор проекта

caricamento build   [project] [--platform android|ios] [--artifact-type apk|aab]
                    [--variant qa|all] [--build <n>] [--version <name>]
caricamento upload  [project] --target firebase|play|playsharing|appstore [--artifact <path>]
                    [--platform android|ios] [--release-notes <text>]
caricamento release [project] [--platform android|ios] [--targets firebase,play|appstore]
                    [--variant qa|all] [...]
caricamento apk     [project] [--artifact <aab>] [--out <apk>]   # AAB → universal APK

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
| `auto-increment has no version source` | Настройте `targets.play` (Android), `targets.appstore` (iOS) или `targets.firebase`, либо смените стратегию/источник (`version.source`) |
| `Signer certificate SHA-256` не совпадает | Подписали не тем keystore — сверьте `expectedCertificateSha256` |
| Play: `Target SDK of artifact is too low: N` | N — это versionCode артефакта, а не SDK. С 31.08.2026 обновления обязаны таргетить API 36 — поднимите `targetSdkVersion` |
| Play: `APK ... not allowed` / просит AAB | Play принимает только AAB — `release` сам переключает apk→aab, для `upload` передайте `--artifact-type aab` |
| iOS: `xcodebuild not found` / `requires Xcode` | Установлены только Command Line Tools — `sudo xcode-select -s /Applications/Xcode.app` |
| iOS: `scheme ... is not currently configured` | Схема не Shared: Xcode → Product → Scheme → Manage Schemes → галочка Shared |
| iOS: `No profiles for '...' were found` / signing-ошибки (`SigningError`) | automatic: проверьте `teamId` и права API-ключа; manual: профиль не совпадает с bundle ID или сертификатом |
| iOS: версия в архиве не совпадает | Info.plist не использует `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)` — замените жёсткие значения на эти переменные |
| ASC `401` | Неверный `keyId`/`issuerId` или ключ отозван (Users and Access → Integrations) |
| ASC `No app with bundle ID` | Запись приложения в App Store Connect не создана или `targets.appstore.bundleId` не совпадает |
| ASC: upload `FAILED` / `already been used` | `CFBundleVersion` уже загружался — используйте `version.strategy: 'auto-increment'` |
| TestFlight: «Missing Compliance» | Добавьте `ITSAppUsesNonExemptEncryption = NO` в Info.plist (или ответьте в ASC) |

## Разработка

```bash
npm run build       # tsup → dist/
npm test            # vitest, 190 тестов (Android SDK / Xcode / Firebase / Play / ASC не нужны)
npm run typecheck
npm run lint        # eslint + правила границ слоёв (SPEC §3.1)
```

`fixtures/` — реальные проекты для ручных end-to-end прогонов:
`android-native` (properties-инжекция), `react-native-cli` и
`react-native-expo` (init-script), `ios-native` (SwiftUI, собирается без
аккаунта в режиме `none`), `flutter` (маркер для детектора).
Подробности — [fixtures/README.md](fixtures/README.md).

## Roadmap

- ~~**Phase 3** — iOS~~ — ✅ реализовано: `xcodebuild`, подпись
  (automatic/manual/none), App Store Connect + TestFlight, auto-increment
  из ASC. Дальше: сабмит на App Store review, Beta App Review для внешних
  групп, автоматический `pod install`
- ~~**Phase 4** — Google Play~~ — ✅ реализовано: edits flow, треки,
  auto-increment versionCode
- **Phase 5** — идемпотентность, ретраи, manual signing для CI
- **Phase 6** — локальный HTTP API + UI поверх того же core

Полная спецификация архитектуры и планов — [SPEC.md](SPEC.md).
