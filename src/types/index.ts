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
}
