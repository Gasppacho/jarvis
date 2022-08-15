import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TodoComponent } from './todo.component';
import { AccueilRoutes } from '../accueil/accueil.routing';
import { TodoRoutes } from './todo.routing';
import { AddTaskModule } from './add-task/add-task.module';

@NgModule({
	imports: [
		CommonModule,
		TodoRoutes,
		AddTaskModule
	],
	declarations: [TodoComponent]
})
export class TodoModule { }
