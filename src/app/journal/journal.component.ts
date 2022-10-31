import { Component, OnDestroy, OnInit } from '@angular/core';
import { Timestamp } from 'firebase/firestore';
import { map, switchMap, TimeoutConfig } from 'rxjs';
import { PageApiService } from '../api/page-api.service';
import { Page } from '../common/page';

@Component({
	selector: 'app-journal',
	templateUrl: './journal.component.html',
	styleUrls: ['./journal.component.css'],
})
export class JournalComponent implements OnInit, OnDestroy {
	private saveClock: any = null;

	public currentDate: Date | null = null;
	public currentPage: Page | null = null;
	public contentHasChanged: boolean = false;

	constructor(private _pageApiService: PageApiService) {}

	ngOnInit() {
		this.getCurrentPage();

		this.saveClock = setInterval(() => {
			if (this.contentHasChanged) {
				this.saveCurrentPage();
			}
		}, 3000);
	}

	ngOnDestroy() {
		clearInterval(this.saveClock);
	}

	private getCurrentPage(): void {
		const today = new Date();
		const day = today.getDate();
		const month = today.getMonth();
		const year = today.getFullYear();

		this.currentDate = new Date(year, month, day);

		this._pageApiService.getPageByDate(this.currentDate).subscribe((page: Page) => {
			console.log('page', page);
			this.currentPage = page;
			console.log('current page', this.currentPage);
			if (!page) {
				const newPage = {
					content: `Aujourd'hui`,
					date: Timestamp.fromDate(this.currentDate as Date),
				} as Page;
				this._pageApiService.createPage(newPage).pipe(
					map((id: string) => {
						console.log('new page id', id);
						this._pageApiService.getPageById(id).subscribe((page: Page) => {
							console.log('new page', page);
							this.currentPage = page;
						});
					}),
				);
			}
		});
	}

	private saveCurrentPage(): void {
		this._pageApiService.updatePage(this.currentPage as Page).subscribe((_) => (this.contentHasChanged = false));
	}
}
