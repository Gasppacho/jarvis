import { Routes, RouterModule } from '@angular/router';
import { JournalComponent } from './journal.component';

const routes: Routes = [
	{
		path: '',
		component: JournalComponent,
	},
];

export const JournalRoutes = RouterModule.forChild(routes);
