export interface Service {
  id: number;
  name: string;
  description: string;
  owner: string;
  created_at?: string;
}

export interface Deployment {
  id: number;
  service_id: number;
  service_name: string;
  environment: string;
  version: string;
  status: string;
  deployed_by: string;
  note: string;
  started_at: string;
  finished_at: string | null;
  /** 指向被本次回滚修复的那条部署记录 id;非回滚记录为 null */
  rollback_from: number | null;
}
