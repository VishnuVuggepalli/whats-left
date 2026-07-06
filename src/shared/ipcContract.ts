import type {
  AccountDto,
  CategoryDto,
  DashboardData,
  EnrollmentResult,
  ImportReport,
  Institution,
  RecategorizeInput,
  ReviewItem,
  SettingsDto,
  SyncReport,
  TransactionDto,
  TxnQuery,
} from './types'

/**
 * The repository-style API the renderer sees (window.api).
 * Desktop impl: IPC → main process. Future PWA impl: fetch → self-hosted server.
 * Renderer code must depend on this interface only.
 */
export interface Api {
  // accounts
  listAccounts(): Promise<AccountDto[]>
  createCsvAccount(input: {
    name: string
    institution: Institution
    type: 'depository' | 'credit'
    mask?: string
  }): Promise<AccountDto>
  linkCsvHistory(csvAccountId: string, tellerAccountId: string): Promise<{ moved: number; matched: number }>

  // csv import
  importCsv(input: {
    accountId: string
    fileName: string
    content: string
    commit: boolean
  }): Promise<ImportReport>

  // transactions
  listTransactions(query: TxnQuery): Promise<{ rows: TransactionDto[]; total: number }>
  recategorize(input: RecategorizeInput): Promise<{ updated: number }>

  // analytics
  getDashboard(month: string): Promise<DashboardData>
  listCategories(): Promise<CategoryDto[]>

  // review queue
  listReviewQueue(): Promise<ReviewItem[]>
  resolveReview(txnId: string, categoryId: string): Promise<void>

  // teller
  syncNow(): Promise<SyncReport>
  startEnrollment(institution?: Institution): Promise<EnrollmentResult>
  reconnect(accountId: string): Promise<EnrollmentResult>

  // settings
  getSettings(): Promise<SettingsDto>
  updateSettings(patch: Partial<SettingsDto>): Promise<SettingsDto>
  exportData(): Promise<{ path: string }>
}

/** IPC channel names — one per Api method, `api:` prefixed. */
export const API_CHANNELS = [
  'listAccounts',
  'createCsvAccount',
  'linkCsvHistory',
  'importCsv',
  'listTransactions',
  'recategorize',
  'getDashboard',
  'listCategories',
  'listReviewQueue',
  'resolveReview',
  'syncNow',
  'startEnrollment',
  'reconnect',
  'getSettings',
  'updateSettings',
  'exportData',
] as const satisfies ReadonlyArray<keyof Api>

export type ApiChannel = (typeof API_CHANNELS)[number]
export const channelName = (m: ApiChannel): string => `api:${m}`
